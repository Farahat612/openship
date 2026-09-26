/**
 * Server-Sent Events bridge for IMAP IDLE.
 *
 * Client opens `GET /mail/idle?folder=inbox` and we hold an IMAP
 * connection open in IDLE on that mailbox. Every EXISTS / EXPUNGE /
 * FETCH from Dovecot becomes one SSE `event: mailbox` line - the
 * client invalidates the threads query in response.
 *
 * We hold one IMAP connection per SSE client. Cheap on the same VPS;
 * if we ever need to scale, share one IMAP connection per mailbox
 * across SSE clients.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getCookie } from 'hono/cookie';
import { ImapFlow } from 'imapflow';
import { env } from '../env';
import { getSession } from '../lib/session';

export const idleRoute = new Hono();

idleRoute.get('/idle', async (c) => {
  const sid = getCookie(c, env.SESSION_COOKIE_NAME);
  if (!sid) return c.text('Unauthorized', 401);
  const session = await getSession(sid);
  if (!session) return c.text('Unauthorized', 401);

  const folder = c.req.query('folder') || 'INBOX';

  return streamSSE(c, async (stream) => {
    const client = new ImapFlow({
      host: session.imapHost,
      port: session.imapPort,
      secure: session.imapPort === 993,
      auth: { user: session.email, pass: session.password },
      logger: false,
    });

    const send = async (event: string, data: unknown) => {
      await stream.writeSSE({ event, data: JSON.stringify(data) });
    };

    const onChange = () => {
      void send('mailbox', { folder, at: new Date().toISOString() });
    };

    try {
      await client.connect();
      await client.mailboxOpen(folder);
      client.on('exists', onChange);
      client.on('expunge', onChange);
      client.on('flags', onChange);
      await client.idle();

      let aborted = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let resolveTimer: (() => void) | null = null;

      const cleanup = async () => {
        if (aborted) return;
        aborted = true;
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        client.removeListener('exists', onChange);
        client.removeListener('expunge', onChange);
        client.removeListener('flags', onChange);
        resolveTimer?.();
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
      };

      stream.onAbort(cleanup);

      // Keep the response open until aborted. `idle()` returns when
      // the IDLE is broken; loop so brief disconnects don't end the
      // stream.
      while (!aborted) {
        await new Promise<void>((r) => {
          resolveTimer = r;
          idleTimer = setTimeout(() => {
            idleTimer = null;
            r();
          }, 1000 * 60 * 25);
        });
        if (aborted) break;
        try {
          await client.noop();
        } catch {
          break;
        }
      }
    } catch (err) {
      await send('error', { message: (err as Error).message }).catch(() => {});
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  });
});
