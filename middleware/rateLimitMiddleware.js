const rateLimit = require('express-rate-limit');

const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
});

module.exports = {
  apiRateLimit,
};
