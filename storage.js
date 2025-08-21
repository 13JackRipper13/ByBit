const fs = require('fs');

function loadUsers() {
    try {
        const data = fs.readFileSync('users.json', 'utf-8');
        return new Set(JSON.parse(data));
    } catch {
        return new Set();
    }
}

function saveUsers(users) {
    fs.writeFileSync('users.json', JSON.stringify(Array.from(users)), 'utf-8');
}

function loadAlerts() {
    try {
        const data = fs.readFileSync('alerts.json', 'utf-8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

function saveAlerts(alerts) {
    fs.writeFileSync('alerts.json', JSON.stringify(alerts), 'utf-8');
}

module.exports = {
    loadUsers,
    saveUsers,
    loadAlerts,
    saveAlerts
};