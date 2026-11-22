'use strict';
// Sauvegarde manuelle : npm run backup
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { backup } = require('../src/backup');

const root = path.join(__dirname, '..');
const DB_FILE = process.env.DB_FILE || path.join(root, 'data', 'proprigo.db');
const DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const db = new DatabaseSync(DB_FILE);
const file = backup(db, DIR);
db.close();
console.log(`Sauvegarde créée : ${file}`);
