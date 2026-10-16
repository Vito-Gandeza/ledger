// Local preview only (not deployed, see .vercelignore): serves the static files the way Vercel
// does and runs api/*.js in-process, so the invest page gets live prices on localhost too.
// node dev.js [port]
const http = require("http"), fs = require("fs"), path = require("path");
const root = __dirname, port = +process.argv[2] || 5177;
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".svg":"image/svg+xml",
  ".webmanifest":"application/manifest+json", ".json":"application/json", ".png":"image/png" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const api = url.pathname.match(/^\/api\/([a-z]+)$/);
  if(api){
    const f = path.join(root, "api", api[1] + ".js");
    if(fs.existsSync(f)) return require(f)(req, res);
  }
  let f = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if(!f.startsWith(root)) { res.statusCode = 403; return res.end(); }
  if(fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  fs.readFile(f, (err, buf) => {
    if(err){ res.statusCode = 404; return res.end("not found"); }
    res.setHeader("content-type", TYPES[path.extname(f)] || "application/octet-stream");
    res.end(buf);
  });
}).listen(port, () => console.log(`http://localhost:${port}`));
