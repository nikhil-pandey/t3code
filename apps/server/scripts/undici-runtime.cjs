const { createRequire } = require("node:module");

module.exports = createRequire(process.execPath)("undici");
