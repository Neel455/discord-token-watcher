const fs = require('fs');
const { STATE_PATH } = require('./config');

// Keyed by source so the same game name from two different sources (e.g.
// a bundle sold on both Steam and Ubisoft) never collides.
function gameKey(sourceKey, label) {
  return `${sourceKey}:${label}`;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { games: {}, watchers: {}, messages: {} };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

module.exports = { gameKey, loadState, saveState };
