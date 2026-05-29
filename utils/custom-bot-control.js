const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'json', 'custom-bot.json');

let state = { enabled: true };

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      state.enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : state.enabled;
    }
  } catch (e) {
    // ignore and keep defaults
  }
}

function save() {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    // ignore write failures
  }
}

function isEnabled() {
  return Boolean(state.enabled);
}

function setEnabled(v) {
  state.enabled = Boolean(v);
  save();
  return getState();
}

function getState() {
  return { enabled: Boolean(state.enabled) };
}

load();

module.exports = { isEnabled, setEnabled, getState };
