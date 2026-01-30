const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(__dirname));

// Serve multiplayer HTML as index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'rummikub-multiplayer.html'));
});

// Game state storage
const games = new Map(); // roomId -> game state

// Game logic helpers
function createDeck() {
  const tiles = [];
  let idCounter = 1;
  const colors = ["red", "blue", "black", "orange"];
  
  // 2 copies of each number/color combination
  for (let copy = 0; copy < 2; copy++) {
    for (const color of colors) {
      for (let n = 1; n <= 13; n++) {
        tiles.push({
          id: `t${idCounter++}`,
          color,
          number: n,
          isJoker: false
        });
      }
    }
  }
  
  // 2 jokers
  for (let j = 0; j < 2; j++) {
    tiles.push({
      id: `t${idCounter++}`,
      color: null,
      number: null,
      isJoker: true
    });
  }
  
  return tiles;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function createGame(roomId, hostId) {
  const deck = shuffle(createDeck());
  const pool = [...deck];
  
  // Create tile registry for quick lookup
  const tileRegistry = new Map();
  deck.forEach(tile => {
    tileRegistry.set(tile.id, tile);
  });
  
  const game = {
    roomId,
    players: [
      {
        id: hostId,
        name: `Player 1`,
        tiles: [],
        isHost: true
      }
    ],
    pool: pool,
    tileRegistry: tileRegistry, // Map of tileId -> tile object
    table: [], // Array of rows, each row is array of tile IDs
    currentTurn: hostId,
    gameState: 'waiting', // waiting, playing, finished
    turnStartTime: Date.now()
  };
  
  // Deal initial tiles
  dealTiles(game, hostId, 14);
  
  games.set(roomId, game);
  return game;
}

function dealTiles(game, playerId, count) {
  const player = game.players.find(p => p.id === playerId);
  if (!player) return;
  
  for (let i = 0; i < count && game.pool.length > 0; i++) {
    const tile = game.pool.pop();
    player.tiles.push(tile);
  }
}

function addPlayerToGame(game, playerId) {
  if (game.players.length >= 2) {
    return false; // Game full
  }
  
  const player = {
    id: playerId,
    name: `Player ${game.players.length + 1}`,
    tiles: [],
    isHost: false
  };
  
  game.players.push(player);
  dealTiles(game, playerId, 14);
  
  // If both players joined, start the game
  if (game.players.length === 2) {
    game.gameState = 'playing';
    game.currentTurn = game.players[0].id; // Host goes first
    game.turnStartTime = Date.now();
  }
  
  return true;
}

function getGameStateForPlayer(game, playerId) {
  const player = game.players.find(p => p.id === playerId);
  const otherPlayer = game.players.find(p => p.id !== playerId);
  
  // Convert table tile IDs to full tile objects
  const tableWithTiles = game.table.map(row => 
    row.map(tileId => game.tileRegistry.get(tileId)).filter(Boolean)
  );
  
  return {
    roomId: game.roomId,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      tileCount: p.tiles.length,
      isHost: p.isHost,
      isYou: p.id === playerId
    })),
    yourTiles: player ? [...player.tiles] : [],
    table: tableWithTiles, // Now contains full tile objects
    poolCount: game.pool.length,
    currentTurn: game.currentTurn,
    gameState: game.gameState,
    isYourTurn: game.currentTurn === playerId,
    otherPlayerTileCount: otherPlayer ? otherPlayer.tiles.length : 0
  };
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // Create or join room
  socket.on('createRoom', (data) => {
    const { roomId, playerName } = data;
    const game = createGame(roomId, socket.id);
    if (playerName) {
      game.players[0].name = playerName;
    }
    
    socket.join(roomId);
    socket.emit('roomCreated', getGameStateForPlayer(game, socket.id));
    console.log(`Room created: ${roomId} by ${socket.id}`);
  });
  
  socket.on('joinRoom', (data) => {
    const { roomId, playerName } = data;
    const game = games.get(roomId);
    
    if (!game) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    if (game.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }
    
    if (!addPlayerToGame(game, socket.id)) {
      socket.emit('error', { message: 'Could not join room' });
      return;
    }
    
    if (playerName) {
      const player = game.players.find(p => p.id === socket.id);
      if (player) player.name = playerName;
    }
    
    socket.join(roomId);
    socket.emit('roomJoined', getGameStateForPlayer(game, socket.id));
    
    // Notify other player
    io.to(roomId).emit('playerJoined', {
      players: game.players.map(p => ({
        id: p.id,
        name: p.name,
        tileCount: p.tiles.length,
        isHost: p.isHost
      })),
      gameState: game.gameState
    });
    
    console.log(`Player ${socket.id} joined room ${roomId}`);
  });
  
  // Game actions
  socket.on('moveTile', (data) => {
    const { roomId, tileId, fromZone, toZone, rowIndex } = data;
    const game = games.get(roomId);
    
    if (!game || game.gameState !== 'playing') {
      socket.emit('error', { message: 'Game not in play' });
      return;
    }
    
    if (game.currentTurn !== socket.id) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }
    
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;
    
    // Move tile from rack to table
    if (fromZone === 'rack' && toZone === 'table') {
      const tileIndex = player.tiles.findIndex(t => t.id === tileId);
      if (tileIndex === -1) return;
      
      const tile = player.tiles.splice(tileIndex, 1)[0];
      
      // Ensure table has enough rows
      while (game.table.length <= rowIndex) {
        game.table.push([]);
      }
      
      game.table[rowIndex].push(tileId);
      
      // Broadcast update
      io.to(roomId).emit('tileMoved', {
        tileId,
        fromZone,
        toZone,
        rowIndex,
        playerId: socket.id,
        tile: tile
      });
    }
    // Move tile from table back to rack
    else if (fromZone === 'table' && toZone === 'rack') {
      // Find and remove from table
      for (let i = 0; i < game.table.length; i++) {
        const index = game.table[i].indexOf(tileId);
        if (index !== -1) {
          game.table[i].splice(index, 1);
          
          // Get tile from registry
          const tile = findTileById(game, tileId);
          if (tile) {
            player.tiles.push(tile);
          }
          
          io.to(roomId).emit('tileMoved', {
            tileId,
            fromZone,
            toZone,
            rowIndex: i,
            playerId: socket.id,
            tile: tile ? { ...tile } : null
          });
          break;
        }
      }
    }
    // Move tile between table rows
    else if (fromZone === 'table' && toZone === 'table') {
      // Remove from source row
      let sourceRowIndex = -1;
      for (let i = 0; i < game.table.length; i++) {
        const index = game.table[i].indexOf(tileId);
        if (index !== -1) {
          game.table[i].splice(index, 1);
          sourceRowIndex = i;
          break;
        }
      }
      
      if (sourceRowIndex !== -1) {
        // Add to target row
        while (game.table.length <= rowIndex) {
          game.table.push([]);
        }
        game.table[rowIndex].push(tileId);
        
        const tile = findTileById(game, tileId);
        io.to(roomId).emit('tileMoved', {
          tileId,
          fromZone,
          toZone,
          rowIndex,
          sourceRowIndex,
          playerId: socket.id,
          tile: tile ? { ...tile } : null
        });
      }
    }
    
    // Send updated game state
    game.players.forEach(p => {
      io.to(p.id).emit('gameStateUpdate', getGameStateForPlayer(game, p.id));
    });
  });
  
  socket.on('drawTile', (data) => {
    const { roomId } = data;
    const game = games.get(roomId);
    
    if (!game || game.gameState !== 'playing') return;
    if (game.currentTurn !== socket.id) return;
    
    if (game.pool.length === 0) {
      socket.emit('error', { message: 'No tiles left in pool' });
      return;
    }
    
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;
    
    const tile = game.pool.pop();
    player.tiles.push(tile);
    
    // End turn after drawing
    game.currentTurn = game.players.find(p => p.id !== socket.id).id;
    game.turnStartTime = Date.now();
    
    io.to(roomId).emit('tileDrawn', {
      playerId: socket.id,
      poolCount: game.pool.length
    });
    
    game.players.forEach(p => {
      io.to(p.id).emit('gameStateUpdate', getGameStateForPlayer(game, p.id));
    });
  });
  
  socket.on('endTurn', (data) => {
    const { roomId } = data;
    const game = games.get(roomId);
    
    if (!game || game.gameState !== 'playing') return;
    if (game.currentTurn !== socket.id) return;
    
    // Switch turn
    game.currentTurn = game.players.find(p => p.id !== socket.id).id;
    game.turnStartTime = Date.now();
    
    io.to(roomId).emit('turnEnded', {
      newTurn: game.currentTurn
    });
    
    game.players.forEach(p => {
      io.to(p.id).emit('gameStateUpdate', getGameStateForPlayer(game, p.id));
    });
  });
  
  socket.on('addRow', (data) => {
    const { roomId } = data;
    const game = games.get(roomId);
    
    if (!game) return;
    
    game.table.push([]);
    
    io.to(roomId).emit('rowAdded', {
      rowCount: game.table.length
    });
  });
  
  socket.on('validateTable', (data) => {
    const { roomId } = data;
    const game = games.get(roomId);
    
    if (!game) return;
    
    // Simple validation (can be enhanced)
    const validation = {
      isValid: true,
      rows: []
    };
    
    socket.emit('tableValidated', validation);
  });
  
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    // Clean up games if player leaves
    for (const [roomId, game] of games.entries()) {
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        // Notify other players
        io.to(roomId).emit('playerLeft', {
          playerId: socket.id
        });
        
        // Remove game if empty or host left
        if (game.players.length === 1 || game.players[playerIndex].isHost) {
          games.delete(roomId);
        } else {
          game.players.splice(playerIndex, 1);
        }
        break;
      }
    }
  });
});

// Helper to find tile by ID (now uses registry)
function findTileById(game, tileId) {
  return game.tileRegistry.get(tileId) || null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Rummikub server running on http://localhost:${PORT}`);
  console.log(`Open rummikub-multiplayer.html in your browser`);
});
