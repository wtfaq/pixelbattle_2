"use strict";

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Разрешаем получать JSON и urlencoded данные в запросах
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Публикуем статические файлы из папки public
app.use(express.static(path.join(__dirname, "public")));

// Инициализация базы данных SQLite3
const db = new sqlite3.Database("./game.db", (err) => {
  if (err) {
    return console.error("Ошибка открытия БД:", err.message);
  }
  console.log("База данных открыта");
});
  
// Создаём таблицы (если их ещё нет)
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      vk_user_id TEXT PRIMARY KEY,
      team TEXT,
      last_placed INTEGER
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS pixels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vk_user_id TEXT,
      team TEXT,
      x INTEGER,
      y INTEGER,
      color TEXT,
      placed_at INTEGER
    )`
  );
});

// Дополнительный мидлвари для всех запросов (кроме /admin) — проверка наличия vk_user_id
app.use((req, res, next) => {
  if (req.path.startsWith("/admin") || req.path.startsWith("/api/admin")) {
    // Здесь на реальном проекте следует добавить проверку прав администратора
    return next();
  }
  // Для прочих API-путей требуем наличие vk_user_id либо в query, либо в body
  if (req.query.vk_user_id || req.body.vk_user_id) {
    req.vk_user_id = req.query.vk_user_id || req.body.vk_user_id;
    return next();
  }
  return res.status(401).send("Unauthorized: vk_user_id required");
});

// API: Проверка, зарегистрирован ли пользователь (используется клиентом для определения необходимости выбора команды)
app.get("/api/get_user", (req, res) => {
  const vk_user_id = req.query.vk_user_id;
  db.get(
    `SELECT * FROM users WHERE vk_user_id = ?`,
    [vk_user_id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) return res.json(row);
      else return res.status(404).json({ error: "User not found" });
    }
  );
});

// API: Выбор команды при первом входе (8 вариантов)
app.post("/api/select_team", (req, res) => {
  const { vk_user_id, team } = req.body;
  if (!vk_user_id || !team) {
    return res.status(400).json({ error: "vk_user_id and team required" });
  }
  const allowedTeams = [
    "red",
    "blue",
    "green",
    "yellow",
    "purple",
    "orange",
    "cyan",
    "magenta",
  ];
  if (!allowedTeams.includes(team)) {
    return res.status(400).json({ error: "Invalid team" });
  }
  // Если пользователь уже существует — ничего не меняем
  db.get(
    `SELECT * FROM users WHERE vk_user_id = ?`,
    [vk_user_id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) {
        return res.json({ message: "Team already selected", team: row.team });
      }
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO users (vk_user_id, team, last_placed) VALUES (?, ?, ?)`,
        [vk_user_id, team, 0],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: "Team selected", team });
        }
      );
    }
  );
});

// API: Размещение пикселя
app.post("/api/place_pixel", (req, res) => {
  const { vk_user_id, x, y, color } = req.body;
  if (x === undefined || y === undefined || !color) {
    return res.status(400).json({ error: "x, y, and color required" });
  }
  // Проверка границ холста
  if (x < 0 || x >= 1000 || y < 0 || y >= 1000) {
    return res.status(400).json({ error: "Coordinates out of bounds" });
  }
  // Допустимые цвета совпадают с вариантами команд
  const allowedColors = [
    "red",
    "blue",
    "green",
    "yellow",
    "purple",
    "orange",
    "cyan",
    "magenta",
  ];
  if (!allowedColors.includes(color)) {
    return res.status(400).json({ error: "Color not allowed" });
  }
  // Получаем данные пользователя (его команду и время последнего размещения)
  db.get(
    `SELECT * FROM users WHERE vk_user_id = ?`,
    [vk_user_id],
    (err, user) => {
      if (err || !user)
        return res.status(400).json({ error: "User not found" });
      const now = Math.floor(Date.now() / 1000);
      // Правило размещения: не чаще одного раза в минуту
      if (now - user.last_placed < 1) {
        return res
          .status(400)
          .json({ error: "You can place a pixel only once per minute" });
      }
      // Вставляем запись о пикселе
      db.run(
        `INSERT INTO pixels (vk_user_id, team, x, y, color, placed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [vk_user_id, user.team, x, y, color, now],
        function (err) {
          if (err)
            return res.status(500).json({ error: err.message });
          // Обновляем время последнего размещения для пользователя
          db.run(
            `UPDATE users SET last_placed = ? WHERE vk_user_id = ?`,
            [now, vk_user_id]
          );
          const pixelData = {
            id: this.lastID,
            vk_user_id,
            team: user.team,
            x,
            y,
            color,
            placed_at: now,
          };
          // Рассылаем событие по WebSocket всем подключённым клиентам
          broadcast(JSON.stringify({ type: "new_pixel", data: pixelData }));
          res.json({ message: "Pixel placed", pixel: pixelData });
        }
      );
    }
  );
});

// API: Получение всех пикселей (для первичной отрисовки)
app.get("/api/get_pixels", (req, res) => {
  db.all(`SELECT * FROM pixels`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// API: Получение статистики по командам (агрегирование пикселей)
app.get("/api/team_stats", (req, res) => {
  db.all(
    `SELECT team, COUNT(*) as pixel_count FROM pixels GROUP BY team`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// API: Подробная статистика для администратора: список всех поставленных пикселей
app.get("/api/admin_pixels", (req, res) => {
  // Здесь желательно добавить реальную проверку администраторских прав
  db.all(`SELECT * FROM pixels ORDER BY placed_at DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Функция рассылки сообщений всем клиентам WebSocket
function broadcast(data) {
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// WebSocket: При подключении клиента выводим сообщение в консоль
wss.on("connection", function connection(ws) {
  console.log("Новый WebSocket клиент подключён");
  ws.on("message", function incoming(message) {
    console.log("Получено сообщение от клиента:", message);
  });
});

// Каждую минуту обновляем «виджет» — эмулируем обновление статистики,
// транслируя статистические данные всем клиентам по WebSocket.
setInterval(() => {
  db.all(
    `SELECT team, COUNT(*) as pixel_count FROM pixels GROUP BY team`,
    (err, rows) => {
      if (!err) {
        broadcast(JSON.stringify({ type: "widget_update", data: rows }));
        console.log("Обновление виджета:", rows);
      }
    }
  );
}, 60000);

// Запускаем сервер
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
