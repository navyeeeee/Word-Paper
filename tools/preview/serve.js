const http=require('http'),fs=require('fs'),path=require('path');
const root=path.join(__dirname,'site');
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.mp3':'audio/mpeg'};
http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x');
  const f=path.join(root, decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
  fs.readFile(f,(e,b)=>{ if(e){res.writeHead(404);res.end('nf');return;} res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'}); res.end(b); });
}).listen(8799,()=>console.log('ready'));
