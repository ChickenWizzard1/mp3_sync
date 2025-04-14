require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const mm = require('music-metadata');

const User = require('./models/User');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("MongoDB verbunden"))
  .catch(err => console.error("MongoDB Fehler", err));

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const audioUpload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/mpeg', 'audio/mp4', 'audio/x-m4b'];
    const allowedExtensions = ['.mp3', '.m4b'];
    const extname = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(extname)) {
      cb(null, true);
    } else {
      cb(new Error('Nur MP3- und M4B-Dateien erlaubt'), false);
    }
  }
});

const imageUpload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Nur Bilddateien erlaubt'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

const auth = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Nicht eingeloggt" });

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    req.user = user;
    next();
  } catch {
    res.status(403).json({ error: "Token ungültig" });
  }
};

io.use((socket, next) => {
  const token = socket.handshake.auth.token ||
               socket.handshake.headers.cookie?.split('token=')[1]?.split(';')[0];

  if (!token) return next(new Error('Not authenticated'));

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

// API Endpunkte
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Benutzername und Passwort benötigt" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hashed });

    const token = jwt.sign({ id: user._id, username }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 2 * 60 * 60 * 1000
    });

    res.json({ message: "Erfolgreich registriert", username });
  } catch (err) {
    if (err.code === 11000) {
      res.status(400).json({ error: "Benutzername existiert bereits" });
    } else {
      res.status(500).json({ error: "Serverfehler bei der Registrierung" });
    }
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });

    if (!user) return res.status(401).json({ error: "Ungültige Anmeldedaten" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Ungültige Anmeldedaten" });

    const token = jwt.sign({ id: user._id, username }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 2 * 60 * 60 * 1000
    });

    res.json({ message: "Erfolgreich eingeloggt" });
  } catch (err) {
    res.status(500).json({ error: "Serverfehler beim Login" });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: "Erfolgreich ausgeloggt" });
});

app.get('/api/user', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('friends', 'username profileImage')
      .populate('friendRequests', 'username profileImage');

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Serverfehler beim Abrufen der Benutzerdaten" });
  }
});

app.get('/api/audio-files', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({
      audioFiles: user.audioFiles,
      albums: user.albums
    });
  } catch (err) {
    res.status(500).json({ error: "Serverfehler beim Abrufen der Audio-Dateien" });
  }
});

app.post('/api/upload-profile', auth, imageUpload.single('profileImage'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Kein Bild hochgeladen" });

    const imagePath = `/uploads/${req.file.filename}`;
    await User.findByIdAndUpdate(req.user.id, { profileImage: imagePath });

    res.json({
      message: "Profilbild erfolgreich aktualisiert",
      profileImage: imagePath
    });
  } catch (err) {
    res.status(500).json({ error: "Serverfehler beim Hochladen des Profilbilds" });
  }
});

app.post('/api/upload-audio', auth, audioUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Keine Datei hochgeladen" });

    const filePath = `/uploads/${req.file.filename}`;
    const user = await User.findById(req.user.id);

    // Metadaten aus der Datei auslesen
    let metadata;
    try {
      metadata = await mm.parseFile(path.join(__dirname, filePath));
    } catch (err) {
      console.error('Fehler beim Auslesen der Metadaten:', err);
    }

    let coverPath = null;
    if (metadata?.common?.picture?.[0]?.data) {
      const coverExt = metadata.common.picture[0].format.split('/')[1] || 'jpg';
      coverPath = `/uploads/cover_${req.file.filename}.${coverExt}`;
      fs.writeFileSync(path.join(__dirname, coverPath), metadata.common.picture[0].data);
    }

    const isM4B = req.file.mimetype === 'audio/mp4';
    if (isM4B) {
      // M4B als Album behandeln
      const chapters = metadata?.native?.['iTunes']?.find(tag => tag.id === 'CHAPTER')?.value || [];
      const album = {
        _id: new mongoose.Types.ObjectId(),
        path: filePath,
        originalName: req.file.originalname,
        title: metadata?.common?.album || req.file.originalname,
        artist: metadata?.common?.artist || 'Unbekannt',
        cover: coverPath,
        duration: req.body.duration || 0,
        chapters: chapters.map(chap => ({
          title: chap.title || `Kapitel ${chap.index + 1}`,
          start: chap.startTime,
          end: chap.endTime
        }))
      };

      user.albums.push(album);
      await user.save();

      res.json({
        message: "Album erfolgreich hochgeladen",
        album
      });
    } else {
      // MP3 als einzelne Datei
      const audioFile = {
        _id: new mongoose.Types.ObjectId(),
        path: filePath,
        originalName: req.file.originalname,
        title: metadata?.common?.title || req.file.originalname,
        artist: metadata?.common?.artist || 'Unbekannt',
        cover: coverPath,
        duration: req.body.duration || 0
      };

      user.audioFiles.push(audioFile);
      await user.save();

      res.json({
        message: "Audio erfolgreich hochgeladen",
        file: audioFile
      });
    }
  } catch (err) {
    console.error('Fehler beim Hochladen der Audio-Datei:', err);
    res.status(500).json({ error: "Serverfehler beim Hochladen der Audio-Datei" });
  }
});

app.delete('/api/delete-audio/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const user = await User.findById(req.user.id);

    let item = user.audioFiles.find(file => file._id.toString() === id);
    let isAlbum = false;

    if (!item) {
      item = user.albums.find(album => album._id.toString() === id);
      isAlbum = true;
    }

    if (!item) {
      return res.status(404).json({ error: "Datei oder Album nicht gefunden" });
    }

    // Datei und Cover aus dem Dateisystem löschen
    const filePath = path.join(__dirname, item.path);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (item.cover) {
      const coverPath = path.join(__dirname, item.cover);
      if (fs.existsSync(coverPath)) {
        fs.unlinkSync(coverPath);
      }
    }

    // Aus Datenbank entfernen
    if (isAlbum) {
      user.albums = user.albums.filter(album => album._id.toString() !== id);
    } else {
      user.audioFiles = user.audioFiles.filter(file => file._id.toString() !== id);
    }
    await user.save();

    res.json({ message: isAlbum ? "Album erfolgreich gelöscht" : "Audio-Datei erfolgreich gelöscht" });
  } catch (err) {
    console.error('Fehler beim Löschen:', err);
    res.status(500).json({ error: "Serverfehler beim Löschen" });
  }
});

app.get('/api/stream-audio/:filename', auth, (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Datei nicht gefunden" });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const mimeType = req.params.filename.endsWith('.m4b') ? 'audio/mp4' : 'audio/mpeg';

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType,
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

app.get('/api/search-users', auth, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query || query.length < 3) {
      return res.status(400).json({ error: "Suchanfrage muss mindestens 3 Zeichen lang sein" });
    }

    const users = await User.find({
      username: { $regex: query, $options: 'i' },
      _id: { $ne: req.user.id }
    }).select('username profileImage');

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Serverfehler bei der Benutzersuche" });
  }
});

app.post('/api/send-friend-request/:userId', auth, async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    if (targetUserId === req.user.id) {
      return res.status(400).json({ error: "Sie können sich nicht selbst hinzufügen" });
    }

    const [user, targetUser] = await Promise.all([
      User.findById(req.user.id),
      User.findById(targetUserId)
    ]);

    if (!targetUser) return res.status(404).json({ error: "Benutzer nicht gefunden" });

    if (user.friends.includes(targetUserId)) {
      return res.status(400).json({ error: "Dieser Benutzer ist bereits Ihr Freund" });
    }

    if (targetUser.friendRequests.includes(req.user.id)) {
      return res.status(400).json({ error: "Freundschaftsanfrage bereits gesendet" });
    }

    targetUser.friendRequests.push(req.user.id);
    await targetUser.save();

    res.json({
      message: "Freundschaftsanfrage gesendet",
      user: {
        id: targetUser._id,
        username: targetUser.username,
        profileImage: targetUser.profileImage
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Serverfehler beim Senden der Freundschaftsanfrage" });
  }
});

app.post('/api/accept-friend/:userId', auth, async (req, res) => {
  try {
    const friendId = req.params.userId;
    const [user, friend] = await Promise.all([
      User.findById(req.user.id),
      User.findById(friendId)
    ]);

    if (!friend) return res.status(404).json({ error: "Benutzer nicht gefunden" });

    if (!user.friendRequests.includes(friendId)) {
      return res.status(400).json({ error: "Keine Freundschaftsanfrage vorhanden" });
    }

    user.friendRequests.pull(friendId);
    user.friends.push(friendId);
    friend.friends.push(req.user.id);

    await Promise.all([user.save(), friend.save()]);
    res.json({
      message: "Freund erfolgreich hinzugefügt",
      friend: {
        id: friend._id,
        username: friend.username,
        profileImage: friend.profileImage
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Serverfehler beim Hinzufügen des Freundes" });
  }
});

app.get('/api/friends', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('friends', 'username profileImage');
    res.json(user.friends);
  } catch (err) {
    res.status(500).json({ error: "Serverfehler beim Abrufen der Freunde" });
  }
});

app.get('/api/friend-requests', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('friendRequests', 'username profileImage');
    res.json(user.friendRequests);
  } catch (err) {
    res.status(500).json({ error: "Serverfehler beim Abrufen der Freundschaftsanfragen" });
  }
});

const rooms = new Map();

io.on('connection', (socket) => {
  if (!socket.user) {
    socket.disconnect(true);
    return;
  }

  socket.on('sync-time', (clientTime) => {
    socket.emit('sync-time-response', {
      serverTime: Date.now(),
      clientTime
    });
  });

  socket.on('join-room', async (roomId) => {
    try {
      socket.join(roomId);

      const user = await User.findById(socket.user.id);
      if (!user) return;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          members: new Map(),
          currentAudio: null,
          isPlaying: false,
          currentTime: 0,
          duration: 0,
          lastUpdate: Date.now(),
          master: socket.user.id,
          chapters: []
        });
      }

      const room = rooms.get(roomId);
      room.members.set(socket.user.id, {
        id: socket.user.id,
        username: user.username,
        profileImage: user.profileImage
      });

      user.currentRoom = roomId;
      await user.save();

      socket.emit('room-state', {
        audio: room.currentAudio,
        isPlaying: room.isPlaying,
        currentTime: room.currentTime,
        duration: room.duration,
        master: room.master,
        chapters: room.chapters,
        serverTime: Date.now()
      });

      io.to(roomId).emit('room-update', {
        members: Array.from(room.members.values()),
        master: room.master
      });
    } catch (err) {
      socket.emit('error', { message: "Fehler beim Beitreten des Raums" });
    }
  });

  socket.on('load-audio', ({ room, path, originalName, title, artist, cover, duration, chapters }) => {
    const roomData = rooms.get(room);
    if (roomData) {
      roomData.currentAudio = { path, originalName, title, artist, cover };
      roomData.isPlaying = false;
      roomData.currentTime = 0;
      roomData.duration = duration;
      roomData.chapters = chapters || [];
      roomData.lastUpdate = Date.now();

      io.to(room).emit('audio-loaded', {
        path,
        originalName,
        title,
        artist,
        cover,
        duration,
        chapters
      });
    }
  });

  socket.on('play', ({ room, timestamp }) => {
    const roomData = rooms.get(room);
    if (roomData) {
      roomData.isPlaying = true;
      roomData.currentTime = timestamp;
      roomData.lastUpdate = Date.now();
      io.to(room).emit('play', { timestamp });
    }
  });

  socket.on('pause', (room) => {
    const roomData = rooms.get(room);
    if (roomData) {
      roomData.isPlaying = false;
      roomData.lastUpdate = Date.now();
      io.to(room).emit('pause');
    }
  });

  socket.on('seek', ({ room, timestamp }) => {
    const roomData = rooms.get(room);
    if (roomData) {
      roomData.currentTime = timestamp;
      roomData.lastUpdate = Date.now();
      io.to(room).emit('seek', { timestamp });
    }
  });

  socket.on('sync-request', (room) => {
    const roomData = rooms.get(room);
    if (roomData) {
      socket.emit('sync-response', {
        currentTime: roomData.currentTime,
        isPlaying: roomData.isPlaying,
        lastUpdate: roomData.lastUpdate,
        audio: roomData.currentAudio,
        duration: roomData.duration,
        chapters: roomData.chapters
      });
    }
  });

  socket.on('leave-room', async () => {
    try {
      if (!socket.user?.id) return;

      await User.findByIdAndUpdate(socket.user.id, { $unset: { currentRoom: 1 } });

      for (const [roomId, room] of rooms.entries()) {
        if (room.members.has(socket.user.id)) {
          room.members.delete(socket.user.id);
          socket.leave(roomId);

          if (room.master === socket.user.id && room.members.size > 0) {
            const newMaster = Array.from(room.members.keys())[0];
            room.master = newMaster;
            console.log(`Neuer Master für Raum ${roomId}: ${newMaster}`);
          }

          if (room.members.size === 0) {
            rooms.delete(roomId);
          } else {
            io.to(roomId).emit('room-update', {
              members: Array.from(room.members.values()),
              master: room.master
            });
          }
        }
      }
    } catch (err) {
      console.error('Fehler beim Verlassen des Raums:', err);
    }
  });

  socket.on('invite-friend', async ({ friendId, roomId }) => {
    try {
      const friend = await User.findById(friendId);
      if (!friend) return;

      const friendSocket = Array.from(io.sockets.sockets.values()).find(
        s => s.user?.id === friendId
      );

      if (friendSocket) {
        friendSocket.emit('room-invite', {
          roomId,
          inviter: socket.user.username
        });
      }
    } catch (err) {
      console.error('Fehler beim Einladen des Freundes:', err);
    }
  });

  socket.on('disconnect', async () => {
    try {
      if (!socket.user?.id) return;

      await User.findByIdAndUpdate(socket.user.id, { $unset: { currentRoom: 1 } });

      for (const [roomId, room] of rooms.entries()) {
        if (room.members.has(socket.user.id)) {
          room.members.delete(socket.user.id);

          if (room.master === socket.user.id && room.members.size > 0) {
            const newMaster = Array.from(room.members.keys())[0];
            room.master = newMaster;
            console.log(`Neuer Master für Raum ${roomId}: ${newMaster}`);
          }

          if (room.members.size === 0) {
            rooms.delete(roomId);
          } else {
            io.to(roomId).emit('room-update', {
              members: Array.from(room.members.values()),
              master: room.master
            });
          }
        }
      }
    } catch (err) {
      console.error('Disconnect error:', err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));