import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import process from 'node:process';

const [archive, portFile] = process.argv.slice(2);
const manifest = JSON.parse(
  execFileSync('/usr/bin/tar', ['-xOzf', archive, 'package/package.json'], {
    encoding: 'utf8',
  }),
);
const bytes = readFileSync(archive);
const filename = '/' + basename(archive);
const server = createServer((request, response) => {
  if (request.url === filename) {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': bytes.length,
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
    return;
  }
  if (decodeURIComponent(request.url ?? '') !== '/' + manifest.name) {
    response.writeHead(404).end();
    return;
  }
  const version = manifest.version;
  const dist = {
    tarball: 'http://127.0.0.1:' + server.address().port + filename,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      name: manifest.name,
      'dist-tags': { latest: version },
      versions: { [version]: { ...manifest, dist } },
    }),
  );
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(portFile, String(server.address().port));
});
