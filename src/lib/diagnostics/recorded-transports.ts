import { errText } from "../err-text";
import { LineBuffer } from "../ynca/line-buffer";
import type { SocketFactory } from "../ynca/ynca-client";
import type { YxcSend } from "../yxc/http-client";
import type { XmlGetter, XmlPoster } from "../xml/xml-client";
import type { TrafficRecorder } from "./traffic-recorder";

/**
 * The three protocols' wire seams with the diagnostics trail listening (plan „Diagnosebericht“, Y1). Recorded at the
 * seam, not in the clients: every line and request passes here — YNCA's bracketed user command and its markers as well
 * as plain lines, MusicCast's and XML's user-priority read-backs as well as the poll — and the time measured is the
 * device's, not the wait in the command gate. Nothing is changed on its way.
 */

/**
 * A YNCA socket factory whose sockets tell the trail every line sent and received — split on the line ends and
 * decoded once per line, like the client does (a character never breaks at a packet border).
 *
 * @param factory the socket factory
 * @param recorder the device's trail
 * @returns the recording factory
 */
export function recordedYncaFactory(factory: SocketFactory, recorder: TrafficRecorder): SocketFactory {
  return (host, port) => {
    const socket = factory(host, port);
    const sent = new LineBuffer();
    const received = new LineBuffer();
    // Every method delegated by name: a socket may carry its methods on a prototype, which a spread would lose.
    return {
      destroy: () => socket.destroy(),
      onConnect: handler => socket.onConnect(handler),
      onClose: handler => socket.onClose(handler),
      onError: handler => socket.onError(handler),
      write: data => {
        for (const line of sent.push(data)) {
          recorder.yncaLine("sent", line);
        }
        socket.write(data);
      },
      onData: handler =>
        socket.onData(chunk => {
          for (const line of received.push(chunk)) {
            recorder.yncaLine("received", line);
          }
          handler(chunk);
        }),
    };
  };
}

/**
 * A MusicCast transport that tells the trail every request, its answer or failure and how long the device took.
 *
 * @param send the transport
 * @param recorder the device's trail
 * @returns the recording transport
 */
export function recordedYxcSend(send: YxcSend, recorder: TrafficRecorder): YxcSend {
  return async (command, body) => {
    const started = Date.now();
    try {
      const answer = await send(command, body);
      recorder.musiccast(command, body, { answer }, Date.now() - started);
      return answer;
    } catch (e) {
      recorder.musiccast(command, body, { error: errText(e) }, Date.now() - started);
      throw e;
    }
  };
}

/**
 * An XML poster that tells the trail every request body, the answer body or failure and the device's time.
 *
 * @param post the poster
 * @param recorder the device's trail
 * @returns the recording poster
 */
export function recordedXmlPoster(post: XmlPoster, recorder: TrafficRecorder): XmlPoster {
  return async (ip, body) => {
    const started = Date.now();
    try {
      const answer = await post(ip, body);
      recorder.xml(body, { answer }, Date.now() - started);
      return answer;
    } catch (e) {
      recorder.xml(body, { error: errText(e) }, Date.now() - started);
      throw e;
    }
  };
}

/**
 * An XML file getter (the device description) that tells the trail the file, its body or failure and the time.
 *
 * @param get the getter
 * @param recorder the device's trail
 * @returns the recording getter
 */
export function recordedXmlGetter(get: XmlGetter, recorder: TrafficRecorder): XmlGetter {
  return async (ip, path) => {
    const started = Date.now();
    try {
      const answer = await get(ip, path);
      recorder.xml(`GET ${path}`, { answer }, Date.now() - started);
      return answer;
    } catch (e) {
      recorder.xml(`GET ${path}`, { error: errText(e) }, Date.now() - started);
      throw e;
    }
  };
}
