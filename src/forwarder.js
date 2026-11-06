// The sandbox's only way out. Runs with `node -e` in its own container, on the
// default bridge and on one profile's internal network. Listens on 443, reads
// the TLS ClientHello's server name, and relays the connection only when that
// name is allowed. TLS stays end to end. Usage: node -e <this> <host>...
const net = require("net");

const allowed = new Set(process.argv.slice(1));

// The server name in a ClientHello: a string, null when there is none or the
// bytes are not a ClientHello, undefined while more bytes are needed.
function serverName(buf) {
  if (buf.length < 5) return undefined;
  if (buf[0] !== 0x16) return null;
  const end = 5 + buf.readUInt16BE(3);
  if (buf.length < end) return undefined;
  try {
    let p = 5;
    if (buf[p] !== 0x01) return null;
    p += 4 + 2 + 32; // handshake header, version, random
    p += 1 + buf[p]; // session id
    p += 2 + buf.readUInt16BE(p); // cipher suites
    p += 1 + buf[p]; // compression methods
    const extEnd = Math.min(end, p + 2 + buf.readUInt16BE(p));
    p += 2;
    while (p + 4 <= extEnd) {
      const type = buf.readUInt16BE(p);
      const len = buf.readUInt16BE(p + 2);
      p += 4;
      if (type === 0 && buf[p + 2] === 0) {
        const n = buf.readUInt16BE(p + 3);
        return buf.toString("ascii", p + 5, p + 5 + n).toLowerCase();
      }
      p += len;
    }
  } catch {}
  return null;
}

net
  .createServer((client) => {
    let buf = Buffer.alloc(0);
    client.setTimeout(10000, () => client.destroy());
    client.on("error", () => client.destroy());
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const host = serverName(buf);
      if (host === undefined && buf.length < 65536) return;
      client.off("data", onData);
      client.pause();
      client.setTimeout(0);
      if (!host || !allowed.has(host)) {
        console.log(`denied ${host || "(no server name)"}`);
        client.destroy();
        return;
      }
      const upstream = net.connect(443, host, () => {
        upstream.write(buf);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on("error", close);
      upstream.on("close", close);
      client.on("close", close);
    };
    client.on("data", onData);
  })
  .listen(443);
