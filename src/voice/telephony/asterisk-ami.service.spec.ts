import { EventEmitter } from 'events';
import * as net from 'net';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AsteriskAmiService } from './asterisk-ami.service';

jest.mock('net', () => ({ createConnection: jest.fn() }));

type Frame = Record<string, string>;

function frame(text: string): Frame {
  return Object.fromEntries(
    text
      .trim()
      .split('\r\n')
      .map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      }),
  );
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: Frame[] = [];
  setEncoding() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  write(text: string) {
    this.writes.push(frame(text));
    return true;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
  receive(headers: Frame) {
    this.emit(
      'data',
      Object.entries(headers)
        .map(([key, value]) => key + ': ' + value)
        .join('\r\n') + '\r\n\r\n',
    );
  }
}

describe('AsteriskAmiService persistent AMI', () => {
  let service: AsteriskAmiService;
  let sockets: FakeSocket[];

  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const login = async (socket: FakeSocket) => {
    socket.emit('connect');
    const id = socket.writes[0].ActionID;
    // Banner, fragmented authentication, and unsolicited event together.
    socket.emit('data', 'Asterisk Call Manager/7.0.0\r\nResponse: Suc');
    socket.emit(
      'data',
      'cess\r\nActionID: ' + id + '\r\n\r\nEvent: FullyBooted\r\n\r\n',
    );
    await flush();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    sockets = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest
      .mocked(net.createConnection)
      .mockReset()
      .mockImplementation(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as net.Socket;
      });
    service = new AsteriskAmiService(
      new ConfigService({
        ASTERISK_AMI_SECRET: 'test-only',
      }),
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves 30 concurrent contexts and 330 variables with one login, without mixing calls', async () => {
    const variables = Array.from({ length: 11 }, (_, i) => 'variable' + i);
    const results = Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        service.resolveAudioSocketContext('call' + i, variables),
      ),
    );
    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    await login(socket);
    expect(socket.writes[0].Events).toBe('off');
    const dbActions = socket.writes.filter((f) => f.Action === 'DBGet');
    expect(dbActions).toHaveLength(30);
    for (const action of dbActions.reverse()) {
      socket.receive({ Response: 'Success', ActionID: action.ActionID });
      socket.receive({
        Event: 'DBGetResponse',
        ActionID: action.ActionID,
        Val: 'channel-' + action.Key,
      });
      socket.receive({ Event: 'DBGetComplete', ActionID: action.ActionID });
    }
    await flush();
    const queries = socket.writes.filter((f) => f.Action === 'Getvar');
    expect(queries).toHaveLength(330);
    // Out-of-order responses, including colons in values and partial frames.
    const data = queries
      .reverse()
      .map(
        (q) =>
          'Response: Success\r\nActionID: ' +
          q.ActionID +
          '\r\nValue: ' +
          q.Channel +
          ':' +
          q.Variable +
          '\r\n\r\n',
      )
      .join('');
    for (let i = 0; i < data.length; i += 71)
      socket.emit('data', data.slice(i, i + 71));
    const contexts = await results;
    contexts.forEach((context, i) => {
      expect(context.channel).toBe('channel-call' + i);
      for (const v of variables)
        expect(context.vars[v]).toBe('channel-call' + i + ':' + v);
    });
    expect(net.createConnection).toHaveBeenCalledTimes(1);
    expect(socket.writes.filter((f) => f.Action === 'Login')).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('uses one real TCP connection for concurrent reads and later commands', async () => {
    jest.useRealTimers();
    const actualNet = jest.requireActual<typeof net>('net');
    jest
      .mocked(net.createConnection)
      .mockImplementation(actualNet.createConnection);
    const peers: net.Socket[] = [];
    let logins = 0;
    const server = actualNet.createServer((peer) => {
      peers.push(peer);
      peer.setEncoding('utf8');
      peer.write('Asterisk Call Manager/7.0.0\r\n');
      let buffer = '';
      peer.on('data', (data: string) => {
        buffer += data;
        let end: number;
        while ((end = buffer.indexOf('\r\n\r\n')) !== -1) {
          const action = frame(buffer.slice(0, end));
          buffer = buffer.slice(end + 4);
          let reply =
            'Response: Success\r\nActionID: ' + action.ActionID + '\r\n';
          if (action.Action === 'Login') logins++;
          if (action.Action === 'Getvar')
            reply += 'Value: olá:' + action.Channel + '\r\n';
          reply += '\r\n';
          if (action.Action === 'DBGet') {
            reply +=
              'Event: DBGetResponse\r\nActionID: ' +
              action.ActionID +
              '\r\nVal: ' +
              action.Key +
              '\r\n\r\n';
          }
          const bytes = Buffer.from(reply);
          const split = bytes.indexOf(Buffer.from('á')) + 1;
          peer.write(bytes.subarray(0, split || 5));
          peer.write(bytes.subarray(split || 5));
        }
      });
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address() as net.AddressInfo;
      service = new AsteriskAmiService(
        new ConfigService({
          ASTERISK_AMI_HOST: '127.0.0.1',
          ASTERISK_AMI_PORT: address.port,
          ASTERISK_AMI_SECRET: 'test-only',
        }),
      );
      const contexts = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          service.resolveAudioSocketContext('call' + i, ['a', 'b']),
        ),
      );
      contexts.forEach((context, i) => {
        expect(context).toEqual({
          channel: 'call' + i,
          vars: { a: 'olá:call' + i, b: 'olá:call' + i },
        });
      });
      expect(await service.hangupChannel('call0')).toBe(true);
      expect(await service.getChannelVariables('later', ['a'])).toEqual({
        a: 'olá:later',
      });
      expect(logins).toBe(1);
      expect(peers).toHaveLength(1);
    } finally {
      service.onModuleDestroy();
      peers.forEach((peer) => peer.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('retains the old UUID fallback and parses missing variables without consuming the next header', async () => {
    const result = service.resolveAudioSocketContext('legacy', [
      'empty',
      'unset',
      'error',
    ]);
    await login(sockets[0]);
    const socket = sockets[0];
    socket.receive({ Response: 'Error', ActionID: socket.writes[1].ActionID });
    await flush();
    const queries = socket.writes.slice(2);
    expect(queries.every((q) => q.Channel === 'legacy')).toBe(true);
    socket.receive({
      Response: 'Success',
      ActionID: queries[0].ActionID,
      Value: '',
      Extra: 'not-a-value',
    });
    socket.receive({
      Response: 'Success',
      ActionID: queries[1].ActionID,
      Value: '<unset>',
    });
    socket.receive({ Response: 'Error', ActionID: queries[2].ActionID });
    expect(await result).toEqual({
      channel: 'legacy',
      vars: { empty: null, unset: null, error: null },
    });
  });

  it('confirms command acceptance, uses async originate, and sanitizes header injection', async () => {
    const dial = service.originate({
      endpoint: 'PJSIP/test',
      context: 'synexa-inbound',
      extension: '2000',
    });
    const hangup = service.hangupChannel('PJSIP/test\r\nAction: Logoff');
    await login(sockets[0]);
    const socket = sockets[0];
    const originate = socket.writes.find((f) => f.Action === 'Originate')!;
    const stop = socket.writes.find((f) => f.Action === 'Hangup')!;
    expect(originate.Async).toBe('true');
    expect(originate.Exten).toBe('2000');
    expect(stop.Channel).toBe('PJSIP/testAction: Logoff');
    socket.receive({ Response: 'Error', ActionID: stop.ActionID });
    socket.receive({
      Event: 'OriginateResponse',
      Response: 'Failure',
      ActionID: originate.ActionID,
    });
    socket.receive({ Response: 'Success', ActionID: originate.ActionID });
    expect(await dial).toBe(true);
    expect(await hangup).toBe(false);
  });

  it('releases all pending requests on disconnect and reconnects on demand without replaying commands', async () => {
    const dial = service.originate({
      endpoint: 'PJSIP/test',
      context: 'synexa-inbound',
      extension: '2000',
    });
    const read = service.getChannelVariables('one', ['a', 'b']);
    await login(sockets[0]);
    const old = sockets[0];
    old.emit('error', new Error('connection lost'));
    expect(await dial).toBe(false);
    expect(await read).toEqual({ a: null, b: null });
    expect(await service.hangupChannel('one')).toBe(false);
    expect(sockets).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1000);
    const retriedRead = service.getChannelVariables('two', ['a']);
    await login(sockets[1]);
    old.emit('close');
    old.receive({ Response: 'Error', ActionID: 'invalid' });
    const action = sockets[1].writes[1];
    sockets[1].receive({
      Response: 'Success',
      ActionID: action.ActionID,
      Value: 'new',
    });
    expect(await retriedRead).toEqual({ a: 'new' });
    expect(sockets[1].writes.map((f) => f.Action)).toEqual(['Login', 'Getvar']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('times out an unresponsive request even when unrelated events keep arriving', async () => {
    const read = service.getChannelVariables('one', ['a', 'b']);
    await login(sockets[0]);
    for (let i = 0; i < 4; i++) {
      sockets[0].receive({ Event: 'Unrelated', ActionID: 'unknown' });
      await jest.advanceTimersByTimeAsync(1000);
    }
    expect(await read).toEqual({ a: null, b: null });
    expect(sockets[0].destroyed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['error', 'end', 'close'])(
    'releases concurrent callers when login receives %s',
    async (event) => {
      const calls = [service.hangupChannel('a'), service.hangupChannel('b')];
      sockets[0].emit(event, new Error('closed'));
      expect(await Promise.all(calls)).toEqual([false, false]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('rejects authentication errors and bounds login time', async () => {
    const first = service.hangupChannel('a');
    sockets[0].emit('connect');
    sockets[0].receive({
      Response: 'Error',
      ActionID: sockets[0].writes[0].ActionID,
    });
    expect(await first).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    const second = service.hangupChannel('b');
    await jest.advanceTimersByTimeAsync(4000);
    expect(await second).toBe(false);
    expect(sockets[1].destroyed).toBe(true);
  });

  it('closes on oversized partial frames and clears waiters', async () => {
    const read = service.hangupChannel('a');
    await login(sockets[0]);
    sockets[0].emit('data', 'x'.repeat(1024 * 1024 + 1));
    expect(await read).toBe(false);
    expect(sockets[0].destroyed).toBe(true);
  });

  it('bounds pending requests on a stalled connection', async () => {
    const calls = Array.from({ length: 1025 }, () =>
      service.hangupChannel('a'),
    );
    await login(sockets[0]);
    expect(sockets[0].writes.filter((f) => f.Action === 'Hangup')).toHaveLength(
      1024,
    );
    service.onModuleDestroy();
    expect((await Promise.all(calls)).every((value) => value === false)).toBe(
      true,
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('closes the connection during shutdown and does not reconnect', async () => {
    const read = service.getChannelVariables('one', ['a']);
    await login(sockets[0]);
    service.onModuleDestroy();
    expect(await read).toEqual({ a: null });
    expect(await service.hangupChannel('one')).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cleans up shutdown during authentication and avoids connecting without credentials', async () => {
    const command = service.hangupChannel('a');
    service.onModuleDestroy();
    expect(await command).toBe(false);
    const unconfigured = new AsteriskAmiService(new ConfigService());
    expect(await unconfigured.getChannelVariables('a', ['b'])).toEqual({});
    expect(await unconfigured.hangupChannel('a')).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
