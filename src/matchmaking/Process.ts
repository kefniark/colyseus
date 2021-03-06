import * as http from 'http';
import * as msgpack from "notepack.io";
import * as memshared from "memshared";
import { Server as WebSocketServer } from "ws";

import { Protocol, decode, send } from "../Protocol";
import { Client, generateId } from "../";
import { handleUpgrade, setUserId } from "../cluster/Worker";

import { debugMatchMaking } from "../Debug";

const server = http.createServer();
server.listen(0, "localhost");

let wss = new WebSocketServer({
  server: server,
  verifyClient: function (info, done) {
    done(true);
  }
});

wss.on('connection', onConnect);

//
// Listen to "redirect" messages from main process, to redirect the connection
// to match-making process.
//
let callbacks: {[requestId:string]: Function} = {};
process.on('message', (message, socket) => {
  if (message[0] === Protocol.PASS_WEBSOCKET) {
    handleUpgrade(server, socket, message);
    return;

  } else if (Array.isArray(message) && callbacks[ message[0] ]) {
    let callback = callbacks[ message.shift() ];
    callback(...message);
    return;
  }
});

function onConnect (client: Client, req?: http.IncomingMessage) {
  // compatibility with ws@3.x.x / uws
  if (req) {
    client.upgradeReq = req;
  }

  // since ws@3.3.3 it's required to listen to 'error' to prevent server crash
  // https://github.com/websockets/ws/issues/1256
  client.on('error', (e) => {/*console.error("[ERROR]", e);*/ });

  setUserId(client);

  client.on('message', (message) => {
    if (!(message = decode(message))) {
      return;
    }

    if (message[0] !== Protocol.JOIN_ROOM) {
      console.error("MatchMaking couldn't process message:", message);
      return;
    }

    let roomName = message[1];
    let joinOptions = message[2];

    // has room handler avaialble?
    memshared.sismember("handlers", roomName, (err, isHandlerAvailable) => {
      if (!isHandlerAvailable) {
        send(client, [Protocol.JOIN_ERROR, roomName, `Error: no available handler for "${ roomName }"`]);
        return;
      }

      // Request to join an existing sessions for requested handler
      memshared.smembers(roomName, (err, availableWorkerIds) => {
        //
        // TODO:
        // remove a room from match-making cache when it reaches maxClients.
        //

        joinOptions.clientId = client.id;

        if (availableWorkerIds.length > 0) {
          broadcastJoinRoomRequest(availableWorkerIds, client, roomName, joinOptions);

        } else {
          // retrieve active worker ids
          requestCreateRoom(client, roomName, joinOptions);
        }
      });

    });

  });
}

function broadcastJoinRoomRequest (availableWorkerIds: string[], client: Client, roomName: string, joinOptions: any) {
  let responsesReceived = [];

  callbacks[ client.id ] = (workerId, roomId, score) => {
    responsesReceived.push({
      roomId: roomId,
      score: score,
      workerId: workerId
    });

    debugMatchMaking("JOIN_ROOM, receiving responses (%d/%d)", responsesReceived.length, availableWorkerIds.length);

    if (responsesReceived.length === availableWorkerIds.length) {
      // sort responses by score
      responsesReceived.sort((a, b) => b.score - a.score);

      let { workerId, roomId, score } = responsesReceived[0];

      if (score === 0) {
        debugMatchMaking("JOIN_ROOM, best score: %d, (options: %j)", score, joinOptions);

        // highest score is 0, let's request to create a room instead of joining.
        requestCreateRoom(client, roomName, joinOptions);

      } else {
        debugMatchMaking("JOIN_ROOM, best score: %d, (options: %j)", score, joinOptions);

        // send join room request to worker id with best score
        joinRoomRequest(workerId, client, roomId, joinOptions);
      }
    }
  }

  availableWorkerIds.forEach(availableWorkerId => {
    // Send JOIN_ROOM command to selected worker process.
    process.send([ availableWorkerId, Protocol.REQUEST_JOIN_ROOM, roomName, joinOptions ]);
  });
}

function joinRoomRequest (workerId, client, roomName, joinOptions) {
  // forward data received from worker process to the client
  callbacks[ client.id ] = (data) => send(client, data);

  // Send JOIN_ROOM command to selected worker process.
  process.send([ workerId, Protocol.JOIN_ROOM, roomName, joinOptions ]);
}

function requestCreateRoom (client, roomName, joinOptions) {
  // forward data received from worker process to the client
  callbacks[ client.id ] = (data) => send(client, data);

  memshared.lrange("workerIds", 0, -1, (err, workerIds) => {
    memshared.mget(workerIds, (err, spawnedRoomCounts) => {
      spawnedRoomCounts = spawnedRoomCounts.filter(count => count);

      let selectedWorkerId = (spawnedRoomCounts.length > 0)
        ? workerIds[ spawnedRoomCounts.indexOf(Math.min(...spawnedRoomCounts)) ]
        : workerIds[0];

      debugMatchMaking("requesting CREATE_ROOM");

      // Send CREATE_ROOM command to selected worker process.
      process.send([ selectedWorkerId, Protocol.CREATE_ROOM, roomName, joinOptions ]);
    });
  });
}
