require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');

const routes = require('./routes');
const { initWebSocket } = require('./websocket');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { globalRateLimit } = require('./middleware/rateLimit');

const app = express();
const server = http.createServer(app);

// Security
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:80', 'http://localhost'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile, curl, server-to-server)
    if (!origin) return callback(null, true);
    // Allow if in whitelist OR if FRONTEND_URL is set to '*'
    if (process.env.FRONTEND_URL === '*' || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origine non autorisée — ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(globalRateLimit);

// Static files (avatars)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// Error handling
app.use(notFound);
app.use(errorHandler);

// WebSocket
initWebSocket(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Pokélo backend running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = { app, server };
