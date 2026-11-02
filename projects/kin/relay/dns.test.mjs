// The relay's authoritative DNS (ADR 0025 §4, §5): answers by hand-built
// query, and over UDP and TCP through Node's own resolver.
import assert from "node:assert/strict";
import { Socket, createSocket } from "node:dgram";
import { Resolver } from "node:dns/promises";
import { once } from "node:events";
import { Server, connect, createServer } from "node:net";
import test from "node:test";
import { Rcode, Type, answerQuery, createDnsServer, encodeName, zoneConfig } from "./dns.mjs";
import { holdTcpOnly } from "./test-support/ports.mjs";

const config = zoneConfig({ zone: "home.test", relayName: "relay.home.test", addresses: ["192.0.2.10", "2001:db8::10"], serial: 2026102201 });
const registry = new Map([
  ["smith.home.test", { routed: true, caaAccountUri: "https://acme.test/acct/7" }],
  ["jones.home.test", { routed: true, caaAccountUri: null }],
]);
const lookup = (name) => registry.get(name) ?? { routed: false, caaAccountUri: null };

function query(name, type, { id = 0x1234, flags = 0x0100, qdcount = 1, klass = 1 } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(qdcount, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(klass, 2);
  return Buffer.concat([header, encodeName(name), tail]);
}
const parse = (response) => ({
  id: response.readUInt16BE(0), flags: response.readUInt16BE(2), rcode: response.readUInt16BE(2) & 0xf,
  aa: Boolean(response.readUInt16BE(2) & 0x0400), tc: Boolean(response.readUInt16BE(2) & 0x0200), ra: Boolean(response.readUInt16BE(2) & 0x0080),
  answers: response.readUInt16BE(6), authority: response.readUInt16BE(8),
});
const ask = (name, type, options) => parse(answerQuery(query(name, type, options), config, lookup));

test("routed names: A/AAAA are the relay's addresses; CAA names the household's ACME account; never HTTPS", () => {
  assert.deepEqual(ask("smith.home.test", Type.A), { id: 0x1234, flags: 0x8500, rcode: 0, aa: true, tc: false, ra: false, answers: 1, authority: 0 });
  assert.equal(ask("smith.home.test", Type.AAAA).answers, 1);
  assert.equal(ask("smith.home.test", Type.CAA).answers, 2, "issue with accounturi, and issuewild \";\"");
  const nodata = ask("smith.home.test", Type.HTTPS);
  assert.equal(nodata.rcode, Rcode.NOERROR);
  assert.equal(nodata.answers, 0, "no HTTPS record, so no ECH configuration");
  assert.equal(nodata.authority, 1, "NODATA carries the SOA");
  assert.equal(ask("jones.home.test", Type.CAA).answers, 0, "no account set: CAA falls back to the zone's issue \";\"");
  assert.equal(ask("smith.home.test", Type.TXT).answers, 0);
});

test("unrouted names are NXDOMAIN; the apex has SOA, NS and CAA 0 issue \";\"", () => {
  assert.equal(ask("nobody.home.test", Type.A).rcode, Rcode.NXDOMAIN);
  assert.equal(ask("a.smith.home.test", Type.A).rcode, Rcode.NXDOMAIN, "nothing below a name");
  assert.equal(ask("home.test", Type.SOA).answers, 1);
  assert.equal(ask("home.test", Type.NS).answers, 2);
  const apexCaa = answerQuery(query("home.test", Type.CAA), config, lookup);
  assert.ok(apexCaa.includes(Buffer.from([0, 5, ...Buffer.from("issue;")])), "0 issue \";\"");
  assert.equal(ask("home.test", Type.A).answers, 0);
  assert.equal(ask("ns1.home.test", Type.A).answers, 1, "in-zone name servers resolve to the relay");
  assert.equal(ask("relay.home.test", Type.AAAA).answers, 1);
});

test("outside the zone, other classes, opcodes and malformed queries", () => {
  const outside = ask("example.org", Type.A);
  assert.equal(outside.rcode, Rcode.REFUSED);
  assert.equal(outside.aa, false);
  assert.equal(ask("smith.home.test", Type.A, { klass: 3 }).rcode, Rcode.REFUSED);
  assert.equal(ask("smith.home.test", Type.A, { flags: 0x0800 }).rcode, Rcode.NOTIMP);
  assert.equal(ask("smith.home.test", Type.A, { qdcount: 2 }).rcode, Rcode.FORMERR);
  assert.equal(answerQuery(query("smith.home.test", Type.A, { flags: 0x8000 }), config, lookup), null, "responses are never answered");
  assert.equal(answerQuery(Buffer.alloc(5), config, lookup), null);
  const pointer = Buffer.concat([query("x", Type.A).subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]);
  assert.equal(parse(answerQuery(pointer, config, lookup)).rcode, Rcode.FORMERR);
  // 0x20 case is echoed and still answered.
  const mixed = answerQuery(query("SmItH.HoMe.TeSt", Type.A), config, lookup);
  assert.equal(parse(mixed).answers, 1);
  assert.ok(mixed.includes(Buffer.from("SmItH")));
});

test("over UDP and TCP with Node's resolver", async () => {
  const server = await createDnsServer({ host: "127.0.0.1", port: 0, config, lookup });
  try {
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    resolver.setServers([`127.0.0.1:${server.udpPort}`]);
    assert.deepEqual(await resolver.resolve4("smith.home.test"), ["192.0.2.10"]);
    assert.deepEqual(await resolver.resolve6("smith.home.test"), ["2001:db8::10"]);
    const caa = await resolver.resolveCaa("smith.home.test");
    assert.deepEqual(caa.map((entry) => entry.issue ?? entry.issuewild).sort(), [";", "letsencrypt.org; accounturi=https://acme.test/acct/7; validationmethods=tls-alpn-01"].sort());
    assert.deepEqual((await resolver.resolveNs("home.test")).sort(), ["ns1.home.test", "ns2.home.test"]);
    assert.equal((await resolver.resolveSoa("home.test")).serial, 2026102201);
    await assert.rejects(resolver.resolve4("nobody.home.test"), (error) => error.code === "ENOTFOUND");
    // TCP: a length-prefixed query.
    const socket = connect(server.tcpPort, "127.0.0.1");
    await once(socket, "connect");
    const message = query("smith.home.test", Type.A);
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(message.length);
    socket.write(Buffer.concat([prefix, message]));
    const [chunk] = await once(socket, "data");
    assert.equal(chunk.readUInt16BE(0), chunk.length - 2);
    assert.equal(parse(chunk.subarray(2)).answers, 1);
    socket.destroy();
  } finally { await server.close(); }
});

test("port 0 picks again when the number UDP got is taken for TCP (#469)", async () => {
  const holder = createServer().listen(0, "127.0.0.1");
  // The holder closes however the test ends, so a failed start fails the
  // test instead of leaving a listener that keeps the process alive.
  try {
    await once(holder, "listening");
    const taken = holder.address().port;
    // The first TCP listen goes to the taken port, as when a loopback client
    // socket holds the number the system just gave UDP. A later pick can
    // land on a taken number for real (#469), so there may be more than two.
    const realListen = Server.prototype.listen;
    const realBind = Socket.prototype.bind;
    const realClose = Socket.prototype.close;
    const failures = [];
    let listens = 0;
    let udpBinds = 0;
    let udpCloses = 0;
    Server.prototype.listen = function (port, ...rest) {
      const listen = (listens += 1);
      this.once("error", (error) => failures.push({ listen, code: error.code }));
      return realListen.call(this, listens === 1 ? taken : port, ...rest);
    };
    Socket.prototype.bind = function (...rest) { udpBinds += 1; return realBind.apply(this, rest); };
    Socket.prototype.close = function (...rest) { udpCloses += 1; return realClose.apply(this, rest); };
    let server;
    try { server = await createDnsServer({ host: "127.0.0.1", port: 0, config, lookup }); } finally {
      Server.prototype.listen = realListen;
      Socket.prototype.bind = realBind;
      Socket.prototype.close = realClose;
    }
    try {
      assert.ok(listens >= 2, "another pair was opened");
      assert.deepEqual(failures[0], { listen: 1, code: "EADDRINUSE" }, "the first listen was the one sent to the taken port");
      assert.equal(failures.length, listens - 1, "only the last listen worked");
      assert.equal(udpCloses, udpBinds - 1, "each UDP socket from a failed pick was closed");
      assert.equal(server.tcpPort, server.udpPort);
      assert.notEqual(server.tcpPort, taken);
    } finally { await server.close(); }
  } finally { await new Promise((resolve) => holder.close(resolve)); }
});

test("port 0 picks again when Windows keeps the number UDP got back from TCP (#469)", async () => {
  // A number in a range Windows keeps back from TCP fails as EACCES.
  // A later pick can land in such a range for real, so there may be more
  // than two listens.
  const realListen = Server.prototype.listen;
  let listens = 0;
  let forced = 0;
  Server.prototype.listen = function (...rest) {
    listens += 1;
    if (listens > 1) return realListen.apply(this, rest);
    forced += 1;
    process.nextTick(() => this.emit("error", Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES", syscall: "listen" })));
    return this;
  };
  let server;
  try { server = await createDnsServer({ host: "127.0.0.1", port: 0, config, lookup }); } finally { Server.prototype.listen = realListen; }
  try {
    assert.ok(listens >= 2, "another pair was opened");
    assert.equal(forced, 1, "the first listen was the one refused");
    assert.equal(server.tcpPort, server.udpPort);
  } finally { await server.close(); }
});

test("port 0 leaves the system's run of numbers when its picks keep being refused (#469)", async () => {
  // Windows gives out port numbers in order, and keeps back whole blocks of
  // a hundred or more from TCP, so asking the system again only steps one
  // number further into the same block. Every number UDP gets from the
  // system is refused here, as if each one fell inside such a block.
  const realBind = Socket.prototype.bind;
  const realListen = Server.prototype.listen;
  let fromSystem = false;
  let refused = 0;
  Socket.prototype.bind = function (port, ...rest) {
    fromSystem = port === 0;
    return realBind.call(this, port, ...rest);
  };
  Server.prototype.listen = function (...rest) {
    if (!fromSystem) return realListen.apply(this, rest);
    refused += 1;
    process.nextTick(() => this.emit("error", Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES", syscall: "listen" })));
    return this;
  };
  let server;
  try { server = await createDnsServer({ host: "127.0.0.1", port: 0, config, lookup }); } finally {
    Socket.prototype.bind = realBind;
    Server.prototype.listen = realListen;
  }
  try {
    assert.equal(refused, 1, "only the system's own pick was refused");
    assert.equal(server.tcpPort, server.udpPort);
  } finally { await server.close(); }
});

test("a random pick UDP already has closes its socket and isn't counted as a DNS error (#469)", async () => {
  // The system's own pick is refused for TCP, and the first random pick
  // lands on a number held for UDP.
  const held = createSocket("udp4");
  await new Promise((resolve, reject) => { held.once("error", reject); held.bind(0, "127.0.0.1", resolve); });
  try {
    const heldPort = held.address().port;
    const realRandom = Math.random;
    const realListen = Server.prototype.listen;
    const realBind = Socket.prototype.bind;
    const realClose = Socket.prototype.close;
    const errors = [];
    let picks = 0;
    let listens = 0;
    let binds = 0;
    let closes = 0;
    Math.random = () => (picks++ === 0 ? (heldPort - 49152 + 0.5) / 16384 : realRandom());
    Server.prototype.listen = function (...rest) {
      listens += 1;
      if (listens > 1) return realListen.apply(this, rest);
      process.nextTick(() => this.emit("error", Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES", syscall: "listen" })));
      return this;
    };
    Socket.prototype.bind = function (...rest) { binds += 1; return realBind.apply(this, rest); };
    Socket.prototype.close = function (...rest) { closes += 1; return realClose.apply(this, rest); };
    let server;
    try { server = await createDnsServer({ host: "127.0.0.1", port: 0, config, lookup, onError: (code) => errors.push(code) }); } finally {
      Math.random = realRandom;
      Server.prototype.listen = realListen;
      Socket.prototype.bind = realBind;
      Socket.prototype.close = realClose;
    }
    try {
      assert.ok(picks >= 1 && binds >= 3, "the held number was tried");
      assert.equal(closes, binds - 1, "each UDP socket from a failed pick was closed");
      assert.deepEqual(errors, [], "a refused pick is not a DNS error");
      assert.notEqual(server.udpPort, heldPort);
    } finally { await server.close(); }
  } finally { await new Promise((resolve) => held.close(resolve)); }
});

test("a port TCP can't take at all fails without leaving its UDP socket open", async () => {
  // dgram cuts 70000 to 16 bits and binds, but net refuses it outright.
  const realClose = Socket.prototype.close;
  let closes = 0;
  Socket.prototype.close = function (...rest) { closes += 1; return realClose.apply(this, rest); };
  try {
    await assert.rejects(createDnsServer({ host: "127.0.0.1", port: 70000, config, lookup }), (error) => error.code === "ERR_SOCKET_BAD_PORT");
  } finally { Socket.prototype.close = realClose; }
  assert.equal(closes, 1, "the UDP socket was closed");
});

test("a fixed port taken for TCP fails without picking again and frees its UDP port", async () => {
  const { taken, release } = await holdTcpOnly();
  try {
    // Should it start after all, it is closed, so the test fails instead of
    // hanging on an open server.
    const started = createDnsServer({ host: "127.0.0.1", port: taken, config, lookup }).then(async (server) => { await server.close(); return server; });
    await assert.rejects(started, (error) => error.code === "EADDRINUSE" && error.syscall === "listen");
    const udp = createSocket("udp4");
    await new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(taken, "127.0.0.1", resolve); });
    await new Promise((resolve) => udp.close(resolve));
  } finally { await release(); }
});
