const http = require('http');
const fs = require('fs');
const path = require('path');
const apiHandler = require('../api/index');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

function serveStatic(req, res) {
  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (req.url.startsWith('/js/')) filePath = path.join(ROOT, req.url.split('?')[0]);
  if (req.url.startsWith('/styles.css')) filePath = path.join(ROOT, 'styles.css');
  if (req.url.startsWith('/index.html')) filePath = path.join(ROOT, 'index.html');
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const ct = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'text/plain';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const apiPath = req.url.split('?')[0];
  if (apiPath === '/api' || apiPath.startsWith('/api/')) {
    return apiHandler(req, res);
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('Dev server on http://localhost:' + PORT);
});
