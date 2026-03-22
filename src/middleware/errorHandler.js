const notFound = (req, res, next) => {
  res.status(404).json({ error: `Route ${req.originalUrl} introuvable` });
};

const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`, err.stack);

  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'Cette valeur existe déjà (contrainte unique).' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Ressource introuvable.' });
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: `Erreur upload: ${err.message}` });
  }

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: process.env.NODE_ENV === 'production' ? 'Erreur serveur interne' : err.message,
  });
};

module.exports = { notFound, errorHandler };
