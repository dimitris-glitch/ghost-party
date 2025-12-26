import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  onSnapshot, 
  updateDoc, 
  arrayUnion,
  getDoc
} from 'firebase/firestore';
import { Ghost, Circle, Copy, Crown, User, ArrowRight, Zap, Clock } from 'lucide-react';

// --- Configuration ---
// Χάρτης 15x15. 
// 1=Τοίχος, 0=Τελεία, 2=Κενό, 9=Pacman Start, 8=Ghost Start, 3=Power Pellet
const MAP_LAYOUT = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,0,1,0,0,0,0,0,0,1],
  [1,3,1,1,1,1,0,1,0,1,1,1,1,3,1], 
  [1,0,1,1,1,1,0,1,0,1,1,1,1,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,0,1,1,2,1,1,0,1,1,0,1],
  [1,0,0,0,0,1,2,8,2,1,0,0,0,0,1], // Ghost House Top
  [1,1,1,1,0,1,2,2,2,1,0,1,1,1,1], // Ghost House Bottom
  [1,0,0,0,0,1,1,1,1,1,0,0,0,0,1],
  [1,0,1,1,0,0,0,9,0,0,0,1,1,0,1], // Pacman Start (9)
  [1,0,1,1,0,1,1,0,1,1,0,1,1,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,3,1,1,1,1,0,1,0,1,1,1,1,3,1], 
  [1,0,0,0,0,0,0,1,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
];

const CELL_SIZE = 24; 
const GAME_SPEED_MS = 250; 
const POWER_MODE_DURATION = 10000; 
const RESPAWN_DELAY = 3000; 

const COLORS = {
  WALL: '#1e3a8a',    
  DOT: '#fcd34d',     
  POWER_PELLET: '#ffffff', 
  PACMAN: '#fbbf24',  
  GHOSTS: ['#ef4444', '#3b82f6', '#ec4899', '#10b981'], 
  SCARED_GHOST: '#3b82f6', 
  BG: '#0f172a'       
};

// --- Firebase Init ---
const firebaseConfig = JSON.parse(window.__firebase_config || '{}');
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = window.__app_id || 'default-app-id';

const GAMES_COLLECTION = 'ghost_party_games'; // Updated Collection Name

// --- CSS for CLASSIC Mouth Animation (Clip-Path) ---
const styles = `
  @keyframes chomp {
    0% { clip-path: polygon(100% 50%, 50% 50%, 100% 50%, 100% 100%, 0% 100%, 0% 0%, 100% 0%); }
    50% { clip-path: polygon(100% 20%, 50% 50%, 100% 80%, 100% 100%, 0% 100%, 0% 0%, 100% 0%); }
    100% { clip-path: polygon(100% 50%, 50% 50%, 100% 50%, 100% 100%, 0% 100%, 0% 0%, 100% 0%); }
  }
  .pacman-mouth {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background-color: #fbbf24;
  }
  .pacman-mouth.animating {
    animation: chomp 0.2s infinite linear;
  }
`;

// --- Helpers for Map Logic ---
const getNextCoords = (dir, startX, startY) => {
  let dx = 0, dy = 0;
  if (dir === 'up') dy = -1;
  if (dir === 'down') dy = 1;
  if (dir === 'left') dx = -1;
  if (dir === 'right') dx = 1;
  return { x: startX + dx, y: startY + dy };
};

const isValidMove = (x, y, role) => {
  if (y < 0 || y >= MAP_LAYOUT.length || x < 0 || x >= MAP_LAYOUT[0].length) return false;
  
  const cell = MAP_LAYOUT[y][x];
  if (cell === 1) return false; 

  // Ghost House Protection for Pacman
  if (role === 'pacman') {
    const isGhostHouse = (x >= 6 && x <= 8 && y >= 6 && y <= 7);
    if (isGhostHouse) return false;
  }

  return true;
};

// --- Main Component ---
export default function App() {
  const [user, setUser] = useState(null);
  const [gameId, setGameId] = useState('');
  const [gameState, setGameState] = useState(null);
  const [inputGameId, setInputGameId] = useState('');
  const [error, setError] = useState('');
  const [myRole, setMyRole] = useState(null); 
  const [currentTime, setCurrentTime] = useState(Date.now()); 
  
  // Refs for Game Loop
  const gameStateRef = useRef(gameState);
  const userRef = useRef(user);
  const myRoleRef = useRef(myRole);
  const directionRef = useRef(null); 

  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);
  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { myRoleRef.current = myRole; }, [myRole]);

  // Timer Tick
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Auth Logic (Simplified)
  useEffect(() => {
    const initAuth = async () => {
      if (window.__initial_auth_token) {
        await signInWithCustomToken(auth, window.__initial_auth_token);
      } else {
        await signInAnonymously(auth);
      }
    };
    initAuth();
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  // Listen to Game State
  useEffect(() => {
    if (!user || !gameId) return;

    const gameRef = doc(db, 'artifacts', appId, 'public', 'data', GAMES_COLLECTION, gameId);
    
    const unsubscribe = onSnapshot(gameRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setGameState(data);
        
        if (data.pacmanId === user.uid) {
          setMyRole('pacman');
        } else if (data.ghosts && data.ghosts[user.uid]) {
          setMyRole('ghost');
        }
      } else {
        setError('Το παιχνίδι δεν βρέθηκε ή έληξε.');
        setGameId('');
      }
    }, (err) => {
      console.error("Firestore error:", err);
      setError('Πρόβλημα σύνδεσης.');
    });

    return () => unsubscribe();
  }, [user, gameId]);

  // --- Game Loop ---
  useEffect(() => {
    const gameLoop = setInterval(async () => {
      const currentGameState = gameStateRef.current;
      const currentUser = userRef.current;
      const currentRole = myRoleRef.current;
      const requestedDir = directionRef.current; 

      const isGameActive = currentGameState?.status === 'playing' || currentGameState?.status === 'waiting';

      if (!currentGameState || !currentUser || !currentRole || !isGameActive) {
        return;
      }

      if (currentRole === 'ghost') {
        const myGhost = currentGameState.ghosts[currentUser.uid];
        if (myGhost && myGhost.respawnUntil && myGhost.respawnUntil > Date.now()) {
          return; 
        }
      }

      let currentX, currentY;
      if (currentRole === 'pacman') {
        currentX = currentGameState.pacmanPos.x;
        currentY = currentGameState.pacmanPos.y;
      } else {
        if (!currentGameState.ghosts || !currentGameState.ghosts[currentUser.uid]) return;
        currentX = currentGameState.ghosts[currentUser.uid].x;
        currentY = currentGameState.ghosts[currentUser.uid].y;
      }

      // LOGIC: Smart Movement
      let finalDir = null;
      let nextPos = null;

      // 1. Try requested direction
      if (requestedDir) {
          const tryPos = getNextCoords(requestedDir, currentX, currentY);
          if (isValidMove(tryPos.x, tryPos.y, currentRole)) {
              finalDir = requestedDir;
              nextPos = tryPos;
          }
      }

      // 2. If blocked, try current direction (Pacman only buffering)
      if (!finalDir && currentRole === 'pacman') {
          const currentServerDir = currentGameState.pacmanDir;
          if (currentServerDir) {
             const tryPos = getNextCoords(currentServerDir, currentX, currentY);
             if (isValidMove(tryPos.x, tryPos.y, currentRole)) {
                 finalDir = currentServerDir;
                 nextPos = tryPos;
             }
          }
      }

      if (!finalDir || !nextPos) return;

      const gameRef = doc(db, 'artifacts', appId, 'public', 'data', GAMES_COLLECTION, gameId);
      const { x: nextX, y: nextY } = nextPos;

      // --- Execute Move ---

      if (currentRole === 'pacman') {
          const dotKey = `${nextX},${nextY}`;
          let updates = {
            pacmanPos: { x: nextX, y: nextY },
            pacmanDir: finalDir
          };
          
          const isPowerMode = currentGameState.powerModeEnds > Date.now();
          
          Object.entries(currentGameState.ghosts || {}).forEach(([ghostId, ghost]) => {
            if (ghost.x === nextX && ghost.y === nextY) {
               const isRespawning = ghost.respawnUntil && ghost.respawnUntil > Date.now();
               
               if (isPowerMode && !isRespawning) {
                  updates[`ghosts.${ghostId}.x`] = 7; 
                  updates[`ghosts.${ghostId}.y`] = 6;
                  updates[`ghosts.${ghostId}.respawnUntil`] = Date.now() + RESPAWN_DELAY;
                  updates.score = (currentGameState.score || 0) + 200;
               } else if (!isPowerMode && !isRespawning) {
                  updates.status = 'lost';
               }
            }
          });

          if (!currentGameState.eatenDots.includes(dotKey)) {
             if (MAP_LAYOUT[nextY][nextX] === 0) {
                updates.eatenDots = arrayUnion(dotKey);
                updates.score = (currentGameState.score || 0) + 10;
             } else if (MAP_LAYOUT[nextY][nextX] === 3) {
                updates.eatenDots = arrayUnion(dotKey);
                updates.score = (currentGameState.score || 0) + 50;
                updates.powerModeEnds = Date.now() + POWER_MODE_DURATION;
             }

             if (currentGameState.eatenDots.length + 1 >= currentGameState.totalDots) {
                updates.status = 'won';
             }
          }
          await updateDoc(gameRef, updates);

      } else {
          // Ghost Move
          let updates = {
            [`ghosts.${currentUser.uid}.x`]: nextX,
            [`ghosts.${currentUser.uid}.y`]: nextY
          };
          
          const isPowerMode = currentGameState.powerModeEnds > Date.now();
          if (nextX === currentGameState.pacmanPos.x && nextY === currentGameState.pacmanPos.y) {
             const isRespawning = currentGameState.ghosts[currentUser.uid].respawnUntil > Date.now();
             if (!isPowerMode && !isRespawning) {
                updates.status = 'lost';
             }
          }
          await updateDoc(gameRef, updates);
      }
    }, GAME_SPEED_MS);

    return () => clearInterval(gameLoop);
  }, [gameId]); 

  // --- Keyboard Input ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
      if (e.key === 'ArrowUp') directionRef.current = 'up';
      else if (e.key === 'ArrowDown') directionRef.current = 'down';
      else if (e.key === 'ArrowLeft') directionRef.current = 'left';
      else if (e.key === 'ArrowRight') directionRef.current = 'right';
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // --- Helpers ---
  const createGame = async () => {
    if (!user) return;
    const newGameId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const gameRef = doc(db, 'artifacts', appId, 'public', 'data', GAMES_COLLECTION, newGameId);

    let dots = [];
    let pacmanStart = {x:7, y:9}; 
    let ghostStart = {x:7, y:6}; 

    MAP_LAYOUT.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (cell === 0 || cell === 3) dots.push(`${x},${y}`);
        if (cell === 9) pacmanStart = {x, y};
        if (cell === 8) ghostStart = {x, y};
      });
    });

    const initialData = {
      status: 'waiting',
      hostId: user.uid,
      pacmanId: user.uid,
      pacmanPos: pacmanStart,
      pacmanDir: 'right',
      score: 0,
      totalDots: dots.length,
      eatenDots: [],
      ghosts: {},
      powerModeEnds: 0,
      createdAt: new Date().toISOString()
    };

    await setDoc(gameRef, initialData);
    setGameId(newGameId);
  };

  const joinGame = async () => {
    if (!user || !inputGameId) return;
    const cleanId = inputGameId.trim().toUpperCase();
    const gameRef = doc(db, 'artifacts', appId, 'public', 'data', GAMES_COLLECTION, cleanId);
    const snap = await getDoc(gameRef);

    if (snap.exists()) {
      const data = snap.data();
      if (data.status !== 'waiting' && data.status !== 'playing') {
        setError('Το παιχνίδι έχει τελειώσει.');
        return;
      }
      if (data.pacmanId === user.uid || (data.ghosts && data.ghosts[user.uid])) {
        setGameId(cleanId);
        return;
      }

      // Find ghost start from map
      let ghostStart = {x:7, y:6}; 
      MAP_LAYOUT.forEach((row, y) => {
        row.forEach((cell, x) => {
          if (cell === 8) ghostStart = {x, y};
        });
      });

      const currentGhostCount = Object.keys(data.ghosts || {}).length;
      await updateDoc(gameRef, {
        [`ghosts.${user.uid}`]: {
          x: ghostStart.x,
          y: ghostStart.y,
          colorIdx: currentGhostCount % 4,
          name: `Ghost ${currentGhostCount + 1}`,
          respawnUntil: 0
        },
        status: 'playing'
      });
      setGameId(cleanId);
    } else {
      setError('Λάθος κωδικός δωματίου.');
    }
  };

  const copyToClipboard = () => {
    const textArea = document.createElement("textarea");
    textArea.value = gameId;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      alert('Ο κωδικός αντιγράφηκε!'); 
    } catch (err) {
      alert('Η αντιγραφή απέτυχε.');
    }
    document.body.removeChild(textArea);
  };

  // --- Views ---
  if (!user) return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">Φόρτωση...</div>;

  if (!gameId) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 text-white font-sans relative">
        <style>{styles}</style>
        <h1 className="text-5xl font-bold mb-8 text-yellow-400 tracking-tighter">GHOST PARTY</h1>
        <div className="absolute top-4 right-4 flex items-center gap-3">
          <div className="text-xs text-slate-500 bg-slate-800 px-2 py-1 rounded border border-slate-700">
             ID: <span className="font-mono text-yellow-500">{user.uid.slice(0, 4)}...</span>
          </div>
        </div>
        <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
          <div className="mb-6">
            <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
               <Crown className="text-yellow-400" size={20}/> Φτιάξε Παιχνίδι
            </h2>
            <p className="text-slate-400 text-sm mb-4">Θα είσαι ο Pac-Man. Οι φίλοι σου θα είναι τα φαντάσματα.</p>
            <button onClick={createGame} className="w-full bg-yellow-500 hover:bg-yellow-400 text-slate-900 font-bold py-3 rounded-lg transition-colors">
              Δημιουργία Δωματίου
            </button>
          </div>
          <div className="relative flex py-5 items-center">
            <div className="flex-grow border-t border-slate-600"></div>
            <span className="flex-shrink mx-4 text-slate-400">Ή</span>
            <div className="flex-grow border-t border-slate-600"></div>
          </div>
          <div>
            <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
               <Ghost className="text-red-400" size={20}/> Μπες σε Παιχνίδι
            </h2>
            <div className="flex gap-2">
              <input type="text" placeholder="Κωδικός Δωματίου" value={inputGameId} onChange={(e) => setInputGameId(e.target.value)} className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500 uppercase tracking-widest" />
              <button onClick={joinGame} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-lg font-bold">Μπες</button>
            </div>
            {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  if (!gameState) return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">Σύνδεση στο δωμάτιο...</div>;

  const isPowerMode = gameState.powerModeEnds > currentTime;
  const powerSecondsLeft = isPowerMode ? Math.ceil((gameState.powerModeEnds - currentTime) / 1000) : 0;

  let isPacmanMoving = false;
  if (gameState.pacmanPos && gameState.pacmanDir) {
      const nextCoords = getNextCoords(gameState.pacmanDir, gameState.pacmanPos.x, gameState.pacmanPos.y);
      if (isValidMove(nextCoords.x, nextCoords.y, 'pacman')) {
          isPacmanMoving = true;
      }
  }

  return (
    <div className={`min-h-screen flex flex-col items-center py-6 select-none font-sans text-white transition-colors duration-500 ${isPowerMode ? 'bg-slate-800' : 'bg-slate-900'}`}>
      <style>{styles}</style>
      
      <div className="w-full max-w-2xl px-4 mb-4 flex justify-between items-center bg-slate-800 p-3 rounded-lg border border-slate-700">
        <div>
          <h2 className="text-xl font-bold text-yellow-400">SCORE: {gameState.score}</h2>
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span>Room: <span className="text-white font-mono">{gameId}</span></span>
            <button onClick={copyToClipboard} className="hover:text-blue-400"><Copy size={14}/></button>
          </div>
        </div>
        
        {isPowerMode && (
           <div className="flex items-center gap-3 text-blue-400 animate-pulse font-bold bg-blue-900/30 px-3 py-1 rounded-full border border-blue-500/30">
              <div className="flex items-center gap-1">
                 <Zap size={18} /> POWER MODE
              </div>
              <div className="flex items-center gap-1 text-white border-l border-blue-500/50 pl-3">
                 <Clock size={16} /> {powerSecondsLeft}s
              </div>
           </div>
        )}

        <div className="text-right">
           <div className="font-bold text-lg flex items-center gap-2 justify-end">
             Είσαι: {myRole === 'pacman' ? <span className="text-yellow-400">Pac-Man</span> : <span className="text-red-400">Φάντασμα</span>}
           </div>
           <div className="text-xs text-slate-400 flex flex-col items-end">
             <span>{Object.keys(gameState.ghosts || {}).length} Φαντάσματα</span>
           </div>
        </div>
      </div>

      {gameState.status === 'lost' && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center">
          <h1 className="text-6xl font-bold text-red-500 mb-4 animate-pulse">GAME OVER</h1>
          <p className="text-xl text-white mb-8">Τα φαντάσματα νίκησαν!</p>
          <button onClick={() => window.location.reload()} className="bg-white text-black px-6 py-3 rounded-full font-bold hover:bg-gray-200">Παίξε ξανά</button>
        </div>
      )}
      {gameState.status === 'won' && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center">
          <h1 className="text-6xl font-bold text-yellow-400 mb-4 animate-bounce">VICTORY!</h1>
          <p className="text-xl text-white mb-8">O Pac-Man έφαγε τα πάντα!</p>
          <button onClick={() => window.location.reload()} className="bg-white text-black px-6 py-3 rounded-full font-bold hover:bg-gray-200">Παίξε ξανά</button>
        </div>
      )}

      <div className="relative bg-black rounded-lg border-4 border-blue-900 shadow-2xl overflow-hidden" style={{ width: MAP_LAYOUT[0].length * CELL_SIZE, height: MAP_LAYOUT.length * CELL_SIZE }}>
        {MAP_LAYOUT.map((row, y) => (
          row.map((cell, x) => {
            const isWall = cell === 1;
            const isDot = cell === 0;
            const isPowerPellet = cell === 3;
            const dotKey = `${x},${y}`;
            const isEaten = gameState.eatenDots && gameState.eatenDots.includes(dotKey);

            return (
              <div key={`${x}-${y}`} className="absolute flex items-center justify-center" style={{ left: x * CELL_SIZE, top: y * CELL_SIZE, width: CELL_SIZE, height: CELL_SIZE, backgroundColor: isWall ? COLORS.WALL : 'transparent' }}>
                {isDot && !isEaten && <div className="rounded-full bg-yellow-200" style={{ width: 4, height: 4 }} />}
                {isPowerPellet && !isEaten && <div className="rounded-full bg-white animate-pulse" style={{ width: 12, height: 12 }} />}
              </div>
            );
          })
        ))}
        {/* Pacman Render */}
        {gameState.pacmanPos && (
          <div 
            className="absolute transition-all duration-300 ease-linear flex items-center justify-center" 
            style={{ 
              left: gameState.pacmanPos.x * CELL_SIZE, 
              top: gameState.pacmanPos.y * CELL_SIZE, 
              width: CELL_SIZE, 
              height: CELL_SIZE,
              transform: `rotate(${
                gameState.pacmanDir === 'up' ? '-90deg' :
                gameState.pacmanDir === 'down' ? '90deg' :
                gameState.pacmanDir === 'left' ? '180deg' : '0deg'
              })`
            }}
          >
            <div className={`pacman-mouth relative ${isPacmanMoving ? 'animating' : ''}`}>
               <div className="absolute top-[15%] right-[30%] w-[15%] h-[15%] bg-black rounded-full" />
            </div>
          </div>
        )}
        {gameState.ghosts && Object.entries(gameState.ghosts).map(([uid, ghost]) => {
           const isRespawning = ghost.respawnUntil && ghost.respawnUntil > Date.now();
           const showScaredColor = isPowerMode && !isRespawning;
           
           return (
            <div key={uid} className={`absolute transition-all duration-300 ease-linear flex items-center justify-center ${isRespawning ? 'opacity-50' : ''}`} style={{ left: ghost.x * CELL_SIZE, top: ghost.y * CELL_SIZE, width: CELL_SIZE, height: CELL_SIZE, zIndex: 10 }}>
               <Ghost 
                  size={20} 
                  color={showScaredColor ? COLORS.SCARED_GHOST : (COLORS.GHOSTS[ghost.colorIdx] || 'red')} 
                  fill={showScaredColor ? COLORS.SCARED_GHOST : (COLORS.GHOSTS[ghost.colorIdx] || 'red')} 
               />
            </div>
           );
        })}
      </div>

      <div className="mt-6 text-slate-400 text-sm max-w-md text-center">
        <p className="mb-2 font-bold text-white">Οδηγίες:</p>
        <p>Φάε τις <span className="text-white font-bold">Λευκές Μπάλες</span> για να κυνηγήσεις τα φαντάσματα!</p>
        <p>Αν σε φάνε, περιμένεις {RESPAWN_DELAY/1000}δ.</p>
      </div>
    </div>
  );
}