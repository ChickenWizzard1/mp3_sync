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
const B2 = require('backblaze-b2');

const User = require('./models/User');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

// Initialize Backblaze B2
const b2 = new B2({
  applicationKeyId: process.env.B2_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY
});

// Authenticate with Backblaze B2 with retry logic
let b2Authorized = false;
async function authorizeB2(retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await b2.authorize();
      b2Authorized = true;
      console.log("Backblaze B2 authorized successfully");
      return true;
    } catch (err) {
      console.error(`Backblaze B2 authorization attempt ${attempt} failed:`, err.message);
      if (attempt < retries) {
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error("Max retries reached. Backblaze B2 authorization failed.");
        return false;
      }
    }
  }
}

// Download file from B2 to temp_uploads
async function downloadFileToTemp(fileName, userId) {
  if (!b2Authorized) {
    throw new Error("B2 not authorized. Please check credentials and network.");
  }

  try {
    // Construct the B2 file path with userId prefix
    const baseName = path.basename(fileName);
    const isCover = fileName.startsWith('covers/');
    const b2FileName = isCover 
      ? `covers/${userId}_${baseName}` 
      : `audio_files/${userId}_${baseName}`;
    
    const localPath = path.join('temp_uploads', baseName);

    // Check if file already exists locally
    if (fs.existsSync(localPath)) {
      console.log(`File ${b2FileName} already exists locally at ${localPath}`);
      return localPath;
    }

    // Download file from B2
    console.log(`Attempting to download ${b2FileName} from B2...`);
    const response = await b2.downloadFileByName({
      bucketName: process.env.B2_BUCKET_NAME,
      fileName: b2FileName,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(localPath);

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`Downloaded file ${b2FileName} to ${localPath}`);
        resolve(localPath);
      });
      writer.on('error', (err) => {
        console.error(`Error writing file ${b2FileName}:`, err);
        reject(err);
      });
    });
  } catch (err) {
    console.error(`Error downloading file ${fileName} from B2:`, err.message);
    throw err;
  }
}

// On server start, download all audio files and covers from B2 to temp_uploads
async function downloadExistingFiles() {
  if (!b2Authorized) {
    console.log("Waiting for B2 authorization before downloading files...");
    const authorized = await authorizeB2();
    if (!authorized) {
      console.error("Cannot download files: B2 authorization failed.");
      return;
    }
  }

  try {
    const users = await User.find({});
    for (const user of users) {
      const userId = user._id.toString();
      
      // Download audio files
      for (const audioFile of user.audioFiles) {
        const fileName = path.basename(audioFile.path);
        const localPath = path.join('temp_uploads', fileName);

        if (!fs.existsSync(localPath)) {
          try {
            await downloadFileToTemp(`audio_files/${fileName}`, userId);
            console.log(`Downloaded audio file: ${fileName} for user ${userId}`);
          } catch (err) {
            console.error(`Error downloading audio file ${fileName} for user ${userId}:`, err.message);
          }
        }
      }

      // Download albums
      for (const album of user.albums) {
        const fileName = path.basename(album.path);
        const localPath = path.join('temp_uploads', fileName);

        if (!fs.existsSync(localPath)) {
          try {
            await downloadFileToTemp(`audio_files/${fileName}`, userId);
            console.log(`Downloaded album: ${fileName} for user ${userId}`);
          } catch (err) {
            console.error(`Error downloading album ${fileName} for user ${userId}:`, err.message);
          }
        }
      }

      // Download covers if they exist
      for (const item of [...user.audioFiles, ...user.albums]) {
        if (item.cover) {
          const coverFileName = path.basename(item.cover);
          const localCoverPath = path.join('temp_uploads', coverFileName);

          if (!fs.existsSync(localCoverPath)) {
            try {
              await downloadFileToTemp(`covers/${coverFileName}`, userId);
              console.log(`Downloaded cover: ${coverFileName} for user ${userId}`);
            } catch (err) {
              console.error(`Error downloading cover ${coverFileName} for user ${userId}:`, err.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error downloading existing files:', err.message);
  }
}

// Create temp_uploads directory if it doesn't exist
if (!fs.existsSync('temp_uploads')) {
  fs.mkdirSync('temp_uploads');
}

// Serve temp_uploads statically for covers and audio
app.use('/temp_uploads', express.static('temp_uploads'));

// Start B2 authorization and file download
(async () => {
  await authorizeB2();
  if (b2Authorized) {
    downloadExistingFiles();
  } else {
    console.error("Server started without B2 authorization. File downloads disabled.");
  }
})();

// Helper function to upload file to B2
async function uploadToB2(file, fileName) {
  if (!b2Authorized) throw new Error("B2 not authorized");

  // Get upload URL
  const { data: { uploadUrl, authorizationToken } } = await b2.getUploadUrl({
    bucketId: process.env.B2_BUCKET_ID
  });

  // Read file data
  const fileData = fs.readFileSync(file.path);

  // Upload file
  const response = await b2.uploadFile({
    uploadUrl,
    uploadAuthToken: authorizationToken,
    fileName: fileName,
    data: fileData,
    mime: file.mimetype
  });

  return response.data;
}

// Helper function to delete file from B2
async function deleteFromB2(fileName) {
  if (!b2Authorized) throw new Error("B2 not authorized");

  try {
    // First get file info
    const { data: { files } } = await b2.listFileNames({
      bucketId: process.env.B2_BUCKET_ID,
      startFileName: fileName,
      maxFileCount: 1
    });

    if (files.length > 0 && files[0].fileName === fileName) {
      await b2.deleteFileVersion({
        fileId: files[0].fileId,
        fileName: fileName
      });
      return true;
    }
    return false;
  } catch (err) {
    console.error("Error deleting file from B2:", err);
    return false;
  }
}

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("MongoDB verbunden"))
  .catch(err => console.error("MongoDB Fehler", err));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'temp_uploads/');
  },
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

    const imagePath = `/temp_uploads/${req.file.filename}`;

    // Upload to B2 for backup
    try {
      const b2FileName = `profile_images/${req.user.id}_${req.file.filename}`;
      await uploadToB2(req.file, b2FileName);
      console.log(`Uploaded profile image ${b2FileName} to B2`);
    } catch (err) {
      console.error('Failed to upload profile image to B2:', err.message);
      // Continue even if B2 upload fails, as local storage is primary
    }

    await User.findByIdAndUpdate(req.user.id, { profileImage: imagePath });

    res.json({
      message: "Profilbild erfolgreich aktualisiert",
      profileImage: imagePath
    });
  } catch (err) {
    console.error('Fehler beim Hochladen des Profilbilds:', err);
    res.status(500).json({ error: "Serverfehler beim Hochladen des Profilbilds" });
  }
});

app.post('/api/upload-audio', auth, audioUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Keine Datei hochgeladen" });

    const filePath = `/temp_uploads/${req.file.filename}`;
    const localFilePath = path.join(__dirname, 'temp_uploads', req.file.filename);

    // Upload main file to B2
    const b2FileName = `audio_files/${req.user.id}_${req.file.filename}`;
    try {
      await uploadToB2(req.file, b2FileName);
      console.log(`Uploaded audio file ${b2FileName} to B2`);
    } catch (err) {
      console.error('Failed to upload audio file to B2:', err.message);
      // Continue with local storage
    }

    // Metadaten aus der Datei auslesen
    let metadata;
    try {
      metadata = await mm.parseFile(localFilePath);
    } catch (err) {
      console.error('Fehler beim Auslesen der Metadaten:', err);
    }

    let coverPath = null;
    if (metadata?.common?.picture?.[0]?.data) {
      const coverExt = metadata.common.picture[0].format.split('/')[1] || 'jpg';
      const coverFileName = `cover_${req.file.filename}.${coverExt}`;
      coverPath = `/temp_uploads/${coverFileName}`;
      const localCoverPath = path.join(__dirname, 'temp_uploads', coverFileName);
      fs.writeFileSync(localCoverPath, metadata.common.picture[0].data);

      // Upload cover to B2 for backup
      try {
        const b2CoverFileName = `covers/${req.user.id}_${coverFileName}`;
        await uploadToB2(
          { path: localCoverPath, originalname: coverFileName, mimetype: metadata.common.picture[0].format },
          b2CoverFileName
        );
        console.log(`Uploaded cover ${b2CoverFileName} to B2`);
      } catch (err) {
        console.error('Failed to upload cover to B2:', err.message);
        // Continue with local storage
      }
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

      await User.findByIdAndUpdate(req.user.id, { $push: { albums: album } });

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

      await User.findByIdAndUpdate(req.user.id, { $push: { audioFiles: audioFile } });

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

    // Delete from B2
    const fileName = path.basename(item.path);
    try {
      await deleteFromB2(`audio_files/${req.user.id}_${fileName}`);
      console.log(`Deleted audio file audio_files/${req.user.id}_${fileName} from B2`);
    } catch (err) {
      console.error(`Failed to delete audio file audio_files/${req.user.id}_${fileName} from B2:`, err.message);
    }

    if (item.cover) {
      const coverFileName = path.basename(item.cover);
      try {
        await deleteFromB2(`covers/${req.user.id}_${coverFileName}`);
        console.log(`Deleted cover covers/${req.user.id}_${coverFileName} from B2`);
      } catch (err) {
        console.error(`Failed to delete cover covers/${req.user.id}_${coverFileName} from B2:`, err.message);
      }
    }

    // Delete local files
    const localFilePath = path.join(__dirname, 'temp_uploads', fileName);
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
      console.log(`Deleted local audio file ${localFilePath}`);
    }

    if (item.cover) {
      const localCoverPath = path.join(__dirname, 'temp_uploads', path.basename(item.cover));
      if (fs.existsSync(localCoverPath)) {
        fs.unlinkSync(localCoverPath);
        console.log(`Deleted local cover ${localCoverPath}`);
      }
    }

    // Remove from database
    if (isAlbum) {
      await User.findByIdAndUpdate(req.user.id, { $pull: { albums: { _id: id } } });
    } else {
      await User.findByIdAndUpdate(req.user.id, { $pull: { audioFiles: { _id: id } } });
    }

    res.json({ message: isAlbum ? "Album erfolgreich gelöscht" : "Audio-Datei erfolgreich gelöscht" });
  } catch (err) {
    console.error('Fehler beim Löschen:', err);
    res.status(500).json({ error: "Serverfehler beim Löschen" });
  }
});

app.get('/api/stream-audio/:filename', auth, (req, res) => {
  const filePath = path.join(__dirname, 'temp_uploads', req.params.filename);

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