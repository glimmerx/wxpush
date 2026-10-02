const names = ['WX_CF_ACCESS_CLIENT_ID', 'WX_CF_ACCESS_CLIENT_SECRET', 'WX_API_TOKEN'];
if (names.some(name => !process.env[name])) {
  console.error('Missing required credential environment variables');
  process.exit(2);
}

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 16 * 1024) {
    console.error('Request exceeds 16 KiB');
    process.exit(2);
  }
  chunks.push(chunk);
}

const body = Buffer.concat(chunks).toString('utf8');
try {
  JSON.parse(body);
  const response = await fetch('https://push-api.matrixsku.com/wxsend', {
    method: 'POST',
    headers: {
      'CF-Access-Client-Id': process.env.WX_CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': process.env.WX_CF_ACCESS_CLIENT_SECRET,
      Authorization: `Bearer ${process.env.WX_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid JSON input' : 'Request failed');
  process.exitCode = 1;
}
