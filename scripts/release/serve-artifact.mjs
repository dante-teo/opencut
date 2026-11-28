import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import process from 'node:process';

const [archive, portFile] = process.argv.slice(2);
const bytes = readFileSync(archive);
const filename = '/' + basename(archive);
const server = createServer((request, response) => {
  if (request.url !== filename) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes.length,
  });
  response.end(request.method === 'HEAD' ? undefined : bytes);
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(portFile, String(server.address().port));
});
