const { app, BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');

// In packaged app, .env must sit next to the executable.
// Load it before index.js so dotenv's second call in index.js is a no-op.
if (app.isPackaged) {
    require('dotenv').config({
        path: path.join(path.dirname(app.getPath('exe')), '.env')
    });
} else {
    require('dotenv').config();
}

// Boot the Express server
require('./index.js');

const PORT = parseInt(process.env.PORT || '3000', 10);

function waitForServer(retries, cb) {
    const sock = new net.Socket();
    sock.connect(PORT, '127.0.0.1', () => { sock.destroy(); cb(); });
    sock.on('error', () => {
        sock.destroy();
        if (retries > 0) setTimeout(() => waitForServer(retries - 1, cb), 250);
        else cb(new Error('Server did not start'));
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        title: 'Serenity',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    win.setMenu(null);
    win.loadURL(`http://127.0.0.1:${PORT}`);
}

app.whenReady().then(() => {
    waitForServer(40, (err) => {
        if (err) {
            console.error('Could not connect to server:', err.message);
            app.quit();
            return;
        }
        createWindow();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
