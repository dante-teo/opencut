import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import process from 'node:process';

const [archive, portFile, ...previous] = process.argv.slice(2);
const archives = new Map(
  [archive, ...previous].map((file) => [
    '/' + basename(file),
    readFileSync(file),
  ]),
);
const server = createServer((request, response) => {
  const bytes = archives.get(request.url);
  if (!bytes) {
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
