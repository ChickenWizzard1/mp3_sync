const socket = io({
  auth: {
    token: document.cookie.split('token=')[1]?.split(';')[0]
  }
});
let currentUser = null;
let currentRoom = null;
const audio = document.getElementById('audioPlayer');
let currentAudioFiles = [];
let currentAlbums = [];
let isSeeking = false;
let masterPeer = null;
let serverTimeOffset = 0;
let isUserInitiated = false;
let hasUserInteracted = false;
let pendingPlayback = null;
let currentChapters = [];

const elements = {
  profileImage: document.getElementById('profileImage'),
  username: document.getElementById('username'),
  userStatus: document.getElementById('userStatus'),
  homeLink: document.getElementById('homeLink'),
  friendsLink: document.getElementById('friendsLink'),
  musicLink: document.getElementById('musicLink'),
  logoutBtn: document.getElementById('logoutBtn'),
  homeSection: document.getElementById('homeSection'),
  friendsSection: document.getElementById('friendsSection'),
  musicSection: document.getElementById('musicSection'),
  pageTitle: document.getElementById('pageTitle'),
  audioList: document.getElementById('audioList'),
  myMusicList: document.getElementById('myMusicList'),
  friendsList: document.getElementById('friendsList'),
  friendRequestsList: document.getElementById('friendRequestsList'),
  currentTrackImage: document.getElementById('currentTrackImage'),
  currentTrackTitle: document.getElementById('currentTrackTitle'),
  currentTrackArtist: document.getElementById('currentTrackArtist'),
  playBtn: document.getElementById('playBtn'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  volumeBtn: document.getElementById('volumeBtn'),
  rewindBtn: document.getElementById('rewindBtn'),
  forwardBtn: document.getElementById('forwardBtn'),
  progress: document.getElementById('progress'),
  currentTime: document.getElementById('currentTime'),
  duration: document.getElementById('duration'),
  progressContainer: document.getElementById('progressContainer'),
  inviteBtn: document.getElementById('inviteBtn'),
  uploadBtn: document.getElementById('uploadBtn'),
  uploadModal: document.getElementById('uploadModal'),
  uploadForm: document.getElementById('uploadForm'),
  inviteModal: document.getElementById('inviteModal'),
  profileImageModal: document.getElementById('profileImageModal'),
  profileImageForm: document.getElementById('profileImageForm'),
  roomInfo: document.getElementById('roomInfo'),
  roomName: document.getElementById('roomName'),
  roomMembers: document.getElementById('roomMembers'),
  inviteFriendsList: document.getElementById('inviteFriendsList'),
  roomCodeInput: document.getElementById('roomCodeInput'),
  joinRoomBtn: document.getElementById('joinRoomBtn'),
  leaveRoomBtn: document.getElementById('leaveRoomBtn'),
  chapterList: document.getElementById('chapterList')
};

async function init() {
  await loadUserData();
  setupEventListeners();
  setupFriendSearch();
  showSection('home');
  await syncServerTime();

  // Audio standardmäßig gemutet
  audio.muted = true;
  elements.volumeBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';

  elements.uploadBtn.addEventListener('click', () => {
    elements.uploadModal.classList.add('active');
  });

  elements.joinRoomBtn.addEventListener('click', () => {
    const roomCode = elements.roomCodeInput.value.trim();
    if (roomCode) {
      joinRoom(roomCode);
    }
  });

  elements.leaveRoomBtn.addEventListener('click', leaveRoom);
}

async function syncServerTime() {
  let offsets = [];
  for (let i = 0; i < 3; i++) {
    const startTime = Date.now();
    await new Promise((resolve) => {
      socket.emit('sync-time', startTime);
      socket.once('sync-time-response', ({ serverTime, clientTime }) => {
        const endTime = Date.now();
        const rtt = endTime - clientTime;
        const offset = serverTime + rtt / 2 - endTime;
        offsets.push(offset);
        resolve();
      });
    });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  serverTimeOffset = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  console.log('Server-Zeit-Offset berechnet:', serverTimeOffset);
}

async function loadUserData() {
  try {
    const response = await fetch('/api/user');
    if (!response.ok) throw new Error('Not authenticated');

    currentUser = await response.json();
    updateProfileUI();
    await loadAudioFiles();
    await loadFriends();
    await loadFriendRequests();

    if (currentUser.currentRoom) {
      joinRoom(currentUser.currentRoom);
    }
  } catch (error) {
    console.error('Fehler beim Laden der Benutzerdaten:', error);
    window.location.href = '/login.html';
  }
}

function updateProfileUI() {
  if (!currentUser) return;

  elements.profileImage.src = currentUser.profileImage || '/default-profile.png';
  elements.username.textContent = currentUser.username;
}

async function loadAudioFiles() {
  try {
    const response = await fetch('/api/audio-files');
    if (!response.ok) throw new Error('Failed to load audio files');

    const data = await response.json();
    currentAudioFiles = data.audioFiles;
    currentAlbums = data.albums;
    console.log('Audio-Dateien und Alben geladen:', { audioFiles: currentAudioFiles, albums: currentAlbums });
    renderAudioList(currentAudioFiles, currentAlbums, elements.audioList);
    renderAudioList(currentAudioFiles, currentAlbums, elements.myMusicList);
  } catch (error) {
    console.error('Fehler beim Laden der Audio-Dateien:', error);
    showError('Fehler beim Laden der Audio-Dateien');
  }
}

async function loadFriends() {
  try {
    const response = await fetch('/api/friends');
    if (!response.ok) throw new Error('Failed to load friends');

    const friends = await response.json();
    renderFriendList(friends, elements.friendsList);
    renderFriendList(friends, elements.inviteFriendsList);
  } catch (error) {
    console.error('Fehler beim Laden der Freunde:', error);
    showError('Fehler beim Laden der Freunde');
  }
}

async function loadFriendRequests() {
  try {
    const response = await fetch('/api/friend-requests');
    if (!response.ok) throw new Error('Failed to load friend requests');

    const requests = await response.json();
    renderFriendRequests(requests, elements.friendRequestsList);
  } catch (error) {
    console.error('Fehler beim Laden der Freundschaftsanfragen:', error);
    showError('Fehler beim Laden der Freundschaftsanfragen');
  }
}

function setupFriendSearch() {
  const searchContainer = document.createElement('div');
  searchContainer.className = 'search-container';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.id = 'friendSearch';
  searchInput.placeholder = 'Freunde suchen...';
  searchInput.className = 'form-input';

  const searchButton = document.createElement('button');
  searchButton.className = 'btn';
  searchButton.innerHTML = '<i class="fas fa-search"></i> Suchen';
  searchButton.addEventListener('click', searchUsers);

  searchContainer.appendChild(searchInput);
  searchContainer.appendChild(searchButton);

  elements.friendsSection.insertBefore(searchContainer, elements.friendsList);

  const searchResults = document.createElement('div');
  searchResults.id = 'searchResults';
  searchResults.className = 'search-results hidden';
  elements.friendsSection.appendChild(searchResults);
}

async function searchUsers() {
  const query = document.getElementById('friendSearch').value.trim();
  if (query.length < 3) {
    showError('Bitte mindestens 3 Zeichen eingeben');
    return;
  }

  try {
    const response = await fetch(`/api/search-users?query=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('Search failed');

    const users = await response.json();
    renderSearchResults(users);
  } catch (error) {
    console.error('Fehler bei der Suche:', error);
    showError('Fehler bei der Suche');
  }
}

function renderSearchResults(users) {
  const container = document.getElementById('searchResults');
  container.innerHTML = '';
  container.classList.remove('hidden');

  if (users.length === 0) {
    container.innerHTML = '<p>Keine Benutzer gefunden</p>';
    return;
  }

  users.forEach(user => {
    const userElement = document.createElement('div');
    userElement.className = 'friend-item';
    userElement.innerHTML = `
      <img src="${user.profileImage || '/default-profile.png'}" class="friend-img">
      <span>${user.username}</span>
      <button class="btn add-friend-btn" data-userid="${user._id}">
        <i class="fas fa-user-plus"></i> Hinzufügen
      </button>
    `;
    container.appendChild(userElement);
  });

  document.querySelectorAll('.add-friend-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const userId = e.target.closest('button').dataset.userid;
      try {
        const response = await fetch(`/api/send-friend-request/${userId}`, {
          method: 'POST'
        });

        if (response.ok) {
          showSuccess('Freundschaftsanfrage gesendet');
          container.classList.add('hidden');
        } else {
          const error = await response.json();
          showError(error.error || 'Fehler beim Senden der Anfrage');
        }
      } catch (error) {
        console.error('Netzwerkfehler beim Senden der Freundschaftsanfrage:', error);
        showError('Netzwerkfehler');
      }
    });
  });
}

function renderAudioList(audioFiles, albums, container) {
  container.innerHTML = '';

  if (audioFiles.length === 0 && albums.length === 0) {
    container.innerHTML = '<p>Keine Audio-Dateien oder Alben gefunden</p>';
    return;
  }

  // Einzelne Tracks (MP3)
  audioFiles.forEach((file, index) => {
    const audioCard = document.createElement('div');
    audioCard.className = 'audio-card';
    audioCard.innerHTML = `
      <div class="audio-cover">
        ${file.cover ? `<img src="${file.cover}" alt="Cover" class="audio-cover-img">` : '<i class="fas fa-music"></i>'}
      </div>
      <div class="audio-title">${file.title || file.originalName}</div>
      <div class="audio-artist">${file.artist || 'Unbekannt'}</div>
      <div class="audio-duration">${formatTime(file.duration)}</div>
      ${container.id === 'myMusicList' ? `
        <button class="btn btn-danger delete-audio-btn" data-id="${file._id}">
          <i class="fas fa-trash"></i>
        </button>
      ` : ''}
    `;
    audioCard.addEventListener('click', (e) => {
      if (!e.target.closest('.delete-audio-btn')) {
        playAudio(file, index, 'track');
      }
    });
    container.appendChild(audioCard);
  });

  // Alben (M4B)
  albums.forEach((album, index) => {
    const albumCard = document.createElement('div');
    albumCard.className = 'album-card';
    albumCard.innerHTML = `
      <div class="audio-cover">
        ${album.cover ? `<img src="${album.cover}" alt="Cover" class="audio-cover-img">` : '<i class="fas fa-book"></i>'}
      </div>
      <div class="album-title">${album.title || album.originalName}</div>
      <div class="album-artist">${album.artist || 'Unbekannt'}</div>
      <div class="album-duration">${formatTime(album.duration)}</div>
      ${container.id === 'myMusicList' ? `
        <button class="btn btn-danger delete-audio-btn" data-id="${album._id}">
          <i class="fas fa-trash"></i>
        </button>
      ` : ''}
    `;
    albumCard.addEventListener('click', (e) => {
      if (!e.target.closest('.delete-audio-btn')) {
        playAudio(album, index, 'album');
      }
    });
    container.appendChild(albumCard);
  });

  if (container.id === 'myMusicList') {
    document.querySelectorAll('.delete-audio-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.closest('button').dataset.id;
        if (confirm('Möchtest du diese Datei oder dieses Album wirklich löschen?')) {
          try {
            const response = await fetch(`/api/delete-audio/${id}`, {
              method: 'DELETE'
            });

            if (response.ok) {
              showSuccess('Erfolgreich gelöscht');
              await loadAudioFiles();
            } else {
              const error = await response.json();
              showError(error.error || 'Fehler beim Löschen');
            }
          } catch (error) {
            console.error('Fehler beim Löschen:', error);
            showError('Netzwerkfehler');
          }
        }
      });
    });
  }
}

function renderFriendList(friends, container) {
  container.innerHTML = '';

  if (friends.length === 0) {
    container.innerHTML = '<p>Keine Freunde gefunden</p>';
    return;
  }

  friends.forEach(friend => {
    const friendItem = document.createElement('div');
    friendItem.className = 'friend-item';
    friendItem.innerHTML = `
      <img src="${friend.profileImage || '/default-profile.png'}" class="friend-img">
      <span>${friend.username}</span>
      ${container.id === 'inviteFriendsList' ?
        `<button class="btn invite-to-room-btn" data-userid="${friend._id}">
          <i class="fas fa-user-plus"></i> Einladen
        </button>` : ''}
    `;
    container.appendChild(friendItem);
  });

  if (container.id === 'inviteFriendsList') {
    document.querySelectorAll('.invite-to-room-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const friendId = e.target.closest('button').dataset.userid;
        inviteFriendToRoom(friendId);
      });
    });
  }
}

function renderFriendRequests(requests, container) {
  container.innerHTML = '';

  if (requests.length === 0) {
    container.innerHTML = '<p>Keine Freundschaftsanfragen</p>';
    return;
  }

  requests.forEach(request => {
    const requestItem = document.createElement('div');
    requestItem.className = 'friend-request-item';
    requestItem.innerHTML = `
      <img src="${request.profileImage || '/default-profile.png'}" class="friend-img">
      <span>${request.username}</span>
      <button class="btn accept-friend-btn" data-userid="${request._id}">
        <i class="fas fa-check"></i> Annehmen
      </button>
    `;
    container.appendChild(requestItem);
  });

  document.querySelectorAll('.accept-friend-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const userId = e.target.closest('button').dataset.userid;
      try {
        const response = await fetch(`/api/accept-friend/${userId}`, {
          method: 'POST'
        });

        if (response.ok) {
          await loadFriends();
          await loadFriendRequests();
          showSuccess('Freund hinzugefügt');
        } else {
          const error = await response.json();
          showError(error.error || 'Fehler beim Annehmen der Freundschaftsanfrage');
        }
      } catch (error) {
        console.error('Netzwerkfehler beim Annehmen der Freundschaftsanfrage:', error);
        showError('Netzwerkfehler');
      }
    });
  });
}

function renderChapters() {
  elements.chapterList.innerHTML = '';
  if (currentChapters.length === 0) {
    elements.chapterList.classList.add('hidden');
    return;
  }

  elements.chapterList.classList.remove('hidden');
  currentChapters.forEach((chapter, index) => {
    const chapterItem = document.createElement('div');
    chapterItem.className = 'chapter-item';
    chapterItem.innerHTML = `
      <span>${chapter.title}</span>
      <span>${formatTime(chapter.start)} - ${formatTime(chapter.end)}</span>
    `;
    chapterItem.addEventListener('click', () => {
      isUserInitiated = true;
      hasUserInteracted = true;
      audio.currentTime = chapter.start;
      if (currentRoom) {
        socket.emit('seek', {
          room: currentRoom,
          timestamp: chapter.start
        });
      }
      playAudioSafely();
    });
    elements.chapterList.appendChild(chapterItem);
  });
}

function setupEventListeners() {
  elements.homeLink.addEventListener('click', (e) => {
    e.preventDefault();
    showSection('home');
  });

  elements.friendsLink.addEventListener('click', (e) => {
    e.preventDefault();
    showSection('friends');
  });

  elements.musicLink.addEventListener('click', (e) => {
    e.preventDefault();
    showSection('music');
  });

  elements.logoutBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/login.html';
    } catch (error) {
      console.error('Fehler beim Ausloggen:', error);
      showError('Fehler beim Ausloggen');
    }
  });

  document.addEventListener('click', () => {
    hasUserInteracted = true;
    if (pendingPlayback) {
      playAudioSafely();
      pendingPlayback = null;
    }
  }, { once: true });

  elements.playBtn.addEventListener('click', () => {
    isUserInitiated = true;
    hasUserInteracted = true;
    togglePlay();
  });

  elements.prevBtn.addEventListener('click', () => {
    isUserInitiated = true;
    hasUserInteracted = true;
    playPrevious();
  });

  elements.nextBtn.addEventListener('click', () => {
    isUserInitiated = true;
    hasUserInteracted = true;
    playNext();
  });

  elements.volumeBtn.addEventListener('click', () => {
    audio.muted = !audio.muted;
    elements.volumeBtn.innerHTML = audio.muted ? '<i class="fas fa-volume-mute"></i>' : '<i class="fas fa-volume-up"></i>';
  });

  elements.rewindBtn.addEventListener('click', () => {
    isUserInitiated = true;
    hasUserInteracted = true;
    skipBackward();
  });

  elements.forwardBtn.addEventListener('click', () => {
    isUserInitiated = true;
    hasUserInteracted = true;
    skipForward();
  });

  elements.progressContainer.addEventListener('click', (e) => {
    isUserInitiated = true;
    hasUserInteracted = true;
    seekAudio.call(elements.progressContainer, e);
  });

  elements.profileImage.addEventListener('click', () => {
    elements.profileImageModal.classList.add('active');
  });

  elements.profileImageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);

    try {
      const response = await fetch('/api/upload-profile', {
        method: 'POST',
        body: formData
      });

      if (response.ok) {
        const data = await response.json();
        elements.profileImage.src = data.profileImage;
        elements.profileImageModal.classList.remove('active');
        showSuccess('Profilbild aktualisiert');
      } else {
        const error = await response.json();
        showError(error.error || 'Fehler beim Hochladen des Profilbilds');
      }
    } catch (error) {
      console.error('Netzwerkfehler beim Hochladen des Profilbilds:', error);
      showError('Netzwerkfehler');
    }
  });

  elements.uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const fileInput = e.target.querySelector('input[type="file"]');
    const file = fileInput.files[0];

    if (file) {
      const tempAudio = new Audio(URL.createObjectURL(file));
      tempAudio.onloadedmetadata = async () => {
        formData.append('duration', Math.floor(tempAudio.duration));
        try {
          const response = await fetch('/api/upload-audio', {
            method: 'POST',
            body: formData
          });

          if (response.ok) {
            showSuccess('Erfolgreich hochgeladen');
            elements.uploadModal.classList.remove('active');
            await loadAudioFiles();
          } else {
            const error = await response.json();
            showError(error.error || 'Fehler beim Hochladen');
          }
        } catch (error) {
          console.error('Netzwerkfehler beim Hochladen:', error);
          showError('Netzwerkfehler beim Hochladen');
        }
      };
      tempAudio.onerror = () => {
        showError('Fehler beim Verarbeiten der Audiodatei');
      };
    }
  });

  elements.inviteBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!currentRoom) {
      createRoom();
    }
    elements.inviteModal.classList.add('active');
  });

  document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal').forEach(modal => {
        modal.classList.remove('active');
      });
    });
  });

  socket.on('connect', () => {
    console.log('Socket.IO verbunden');
    if (currentRoom) {
      socket.emit('join-room', currentRoom);
    }
  });

  socket.on('room-state', (state) => {
    if (!currentRoom) return;

    console.log('Raumstatus empfangen:', state);
    if (state.audio) {
      elements.currentTrackTitle.textContent = state.audio.title || state.audio.originalName;
      elements.currentTrackArtist.textContent = state.audio.artist || 'Unbekannt';
      elements.currentTrackImage.innerHTML = state.audio.cover
        ? `<img src="${state.audio.cover}" alt="Cover" class="player-img-cover">`
        : `<i class="fas fa-${state.chapters?.length > 0 ? 'book' : 'music'}"></i>`;
      elements.duration.textContent = formatTime(state.duration);
      audio.src = state.audio.path;
      console.log('Audioquelle gesetzt:', audio.src);
      audio.currentTime = state.currentTime;
      currentChapters = state.chapters || [];
      renderChapters();
      masterPeer = state.master === currentUser._id ? socket.id : null;
      if (state.isPlaying) {
        if (hasUserInteracted) {
          playAudioSafely();
        } else {
          pendingPlayback = true;
          console.log('Warte auf Benutzerinteraktion für room-state Wiedergabe');
        }
      } else {
        audio.pause();
        elements.playBtn.innerHTML = '<i class="fas fa-play"></i>';
      }
    }
  });

  socket.on('audio-loaded', ({ path, originalName, title, artist, cover, duration, chapters }) => {
    if (!currentRoom) return;

    console.log('Audio geladen:', { path, originalName, title, artist, cover, duration, chapters });
    elements.currentTrackTitle.textContent = title || originalName;
    elements.currentTrackArtist.textContent = artist || 'Unbekannt';
    elements.currentTrackImage.innerHTML = cover
      ? `<img src="${cover}" alt="Cover" class="player-img-cover">`
      : `<i class="fas fa-${chapters?.length > 0 ? 'book' : 'music'}"></i>`;
    elements.duration.textContent = formatTime(duration);
    audio.src = path;
    audio.currentTime = 0;
    audio.pause();
    currentChapters = chapters || [];
    renderChapters();
    elements.playBtn.innerHTML = '<i class="fas fa-play"></i>';
    isUserInitiated = false;
  });

  socket.on('play', ({ timestamp }) => {
    if (!currentRoom) return;

    console.log('Play-Event empfangen:', { timestamp });
    audio.currentTime = timestamp;
    if (hasUserInteracted) {
      playAudioSafely();
    } else {
      pendingPlayback = true;
      console.log('Warte auf Benutzerinteraktion für play event');
    }
  });

  socket.on('pause', () => {
    if (!currentRoom) return;

    console.log('Pause-Event empfangen');
    audio.pause();
    elements.playBtn.innerHTML = '<i class="fas fa-play"></i>';
    isUserInitiated = false;
  });

  socket.on('seek', ({ timestamp }) => {
    if (!currentRoom) return;

    console.log('Seek-Event empfangen:', { timestamp });
    isSeeking = true;
    audio.currentTime = timestamp;
    setTimeout(() => { isSeeking = false; }, 100);
  });

  socket.on('sync-pulse', ({ currentTime }) => {
    if (!currentRoom || masterPeer === socket.id) return;

    if (Math.abs(audio.currentTime - currentTime) > 0.5 && !audio.paused) {
      console.log('Synchronisation erforderlich:', { current: audio.currentTime, target: currentTime });
      audio.currentTime = currentTime;
    }
  });

  socket.on('sync-response', (state) => {
    console.log('Sync-Response empfangen:', state);
    if (state.audio) {
      elements.currentTrackTitle.textContent = state.audio.title || state.audio.originalName;
      elements.currentTrackArtist.textContent = state.audio.artist || 'Unbekannt';
      elements.currentTrackImage.innerHTML = state.audio.cover
        ? `<img src="${state.audio.cover}" alt="Cover" class="player-img-cover">`
        : `<i class="fas fa-${state.chapters?.length > 0 ? 'book' : 'music'}"></i>`;
      elements.duration.textContent = formatTime(state.duration);
      audio.src = state.audio.path;
      audio.currentTime = state.currentTime;
      currentChapters = state.chapters || [];
      renderChapters();
      if (state.isPlaying) {
        if (hasUserInteracted) {
          playAudioSafely();
        } else {
          pendingPlayback = true;
          console.log('Warte auf Benutzerinteraktion für sync-response Wiedergabe');
        }
      }
      elements.playBtn.innerHTML = state.isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    }
  });

  socket.on('room-update', ({ members, master }) => {
    console.log('Raum-Update:', { members, master });
    updateRoomMembers(members);
    masterPeer = master === currentUser._id ? socket.id : null;
  });

  socket.on('room-invite', (data) => {
    console.log('Einladung empfangen:', data);
    const accept = confirm(`${data.inviter} hat dich in einen Raum eingeladen. Möchtest du beitreten?`);
    if (accept) {
      joinRoom(data.roomId);
    }
  });

  socket.on('error', ({ message }) => {
    console.error('Socket.IO-Fehler:', message);
    showError(message);
  });

  audio.addEventListener('timeupdate', () => {
    if (isSeeking) return;

    updateProgress();
  });

  audio.addEventListener('loadedmetadata', () => {
    console.log('Audio-Metadaten geladen:', { duration: audio.duration });
    elements.duration.textContent = formatTime(audio.duration);
    audio.preload = 'auto';
  });

  audio.addEventListener('ended', () => {
    console.log('Audio beendet');
    playNext();
  });

  audio.addEventListener('waiting', () => {
    console.log('Audio puffert...');
  });

  audio.addEventListener('canplay', () => {
    console.log('Audio kann abgespielt werden');
    if (masterPeer !== socket.id && audio.paused && elements.playBtn.innerHTML.includes('pause')) {
      if (hasUserInteracted) {
        playAudioSafely();
      } else {
        pendingPlayback = true;
      }
    }
  });

  audio.addEventListener('error', (e) => {
    console.error('Audiofehler:', e);
    showError('Fehler beim Laden der Audiodatei. Bitte versuche es erneut.');
  });
}

function playAudioSafely() {
  if (!audio.src) {
    console.error('Keine Audioquelle gesetzt');
    showError('Kein Audio ausgewählt');
    return;
  }

  elements.playBtn.innerHTML = '<i class="fas fa-pause"></i>';

  if (!hasUserInteracted) {
    console.log('Warte auf Benutzerinteraktion für Wiedergabe');
    pendingPlayback = true;
    showInteractionPrompt();
    return;
  }

  const playPromise = audio.play();
  if (playPromise !== undefined) {
    playPromise.then(() => {
      console.log('Audio wird abgespielt');
      pendingPlayback = null;
    }).catch(err => {
      console.error('Fehler beim Abspielen des Audios:', err);
      elements.playBtn.innerHTML = '<i class="fas fa-play"></i>';
      pendingPlayback = true;
      showInteractionPrompt();
      showError('Bitte interagiere mit der Seite, um die Wiedergabe zu starten');
    });
  }
}

function showInteractionPrompt() {
  const existingPrompt = document.querySelector('.interaction-prompt');
  if (existingPrompt) return;

  const prompt = document.createElement('div');
  prompt.className = 'interaction-prompt';
  prompt.innerHTML = `
    <p>Bitte klicke, um die Musikwiedergabe zu starten</p>
    <button class="btn" id="startPlaybackBtn">Starten</button>
  `;
  document.body.appendChild(prompt);

  document.getElementById('startPlaybackBtn').addEventListener('click', () => {
    hasUserInteracted = true;
    prompt.remove();
    if (pendingPlayback) {
      playAudioSafely();
      pendingPlayback = null;
    }
  });
}

function showSection(section) {
  elements.homeSection.classList.add('hidden');
  elements.friendsSection.classList.add('hidden');
  elements.musicSection.classList.add('hidden');

  elements.homeLink.classList.remove('active');
  elements.friendsLink.classList.remove('active');
  elements.musicLink.classList.remove('active');

  document.getElementById(`${section}Section`).classList.remove('hidden');
  document.getElementById(`${section}Link`).classList.add('active');

  elements.pageTitle.textContent =
    section === 'home' ? 'Willkommen zurück' :
    section === 'friends' ? 'Freunde' :
    'Meine Musik';
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

let currentAudioIndex = 0;
let currentItemType = 'track';

function playAudio(item, index, type) {
  currentAudioIndex = index;
  currentItemType = type;

  const isAlbum = type === 'album';
  if (currentRoom) {
    console.log(`Lade ${isAlbum ? 'Album' : 'Track'} in Raum:`, item);
    socket.emit('load-audio', {
      room: currentRoom,
      path: item.path,
      originalName: item.originalName,
      title: item.title,
      artist: item.artist,
      cover: item.cover,
      duration: item.duration || 0,
      chapters: isAlbum ? item.chapters : []
    });
  } else {
    console.log(`Lokale Wiedergabe (${type}):`, item);
    audio.src = item.path;
    elements.currentTrackTitle.textContent = item.title || item.originalName;
    elements.currentTrackArtist.textContent = item.artist || 'Unbekannt';
    elements.currentTrackImage.innerHTML = item.cover
      ? `<img src="${item.cover}" alt="Cover" class="player-img-cover">`
      : `<i class="fas fa-${isAlbum ? 'book' : 'music'}"></i>`;
    elements.duration.textContent = formatTime(item.duration);
    currentChapters = isAlbum ? item.chapters : [];
    renderChapters();
    isUserInitiated = true;
    playAudioSafely();
  }
}

function togglePlay() {
  if (!audio.src) {
    console.error('Keine Audioquelle für togglePlay');
    showError('Kein Audio ausgewählt');
    return;
  }

  if (currentRoom) {
    if (audio.paused) {
      console.log('Starte Wiedergabe');
      socket.emit('play', {
        room: currentRoom,
        timestamp: audio.currentTime
      });
      playAudioSafely();
    } else {
      console.log('Pausiere Wiedergabe');
      socket.emit('pause', currentRoom);
      audio.pause();
      elements.playBtn.innerHTML = '<i class="fas fa-play"></i>';
    }
  } else {
    if (audio.paused) {
      console.log('Lokale Wiedergabe starten');
      playAudioSafely();
    } else {
      console.log('Lokale Wiedergabe pausieren');
      audio.pause();
      elements.playBtn.innerHTML = '<i class="fas fa-play"></i>';
    }
  }
}

function playPrevious() {
  if (currentItemType === 'track' && currentAudioFiles.length > 0) {
    currentAudioIndex--;
    if (currentAudioIndex < 0) {
      currentAudioIndex = currentAudioFiles.length - 1;
    }
    playAudio(currentAudioFiles[currentAudioIndex], currentAudioIndex, 'track');
  } else if (currentItemType === 'album' && currentAlbums.length > 0) {
    currentAudioIndex--;
    if (currentAudioIndex < 0) {
      currentAudioIndex = currentAlbums.length - 1;
    }
    playAudio(currentAlbums[currentAudioIndex], currentAudioIndex, 'album');
  }
}

function playNext() {
  if (currentItemType === 'track' && currentAudioFiles.length > 0) {
    currentAudioIndex++;
    if (currentAudioIndex >= currentAudioFiles.length) {
      currentAudioIndex = 0;
    }
    playAudio(currentAudioFiles[currentAudioIndex], currentAudioIndex, 'track');
  } else if (currentItemType === 'album' && currentAlbums.length > 0) {
    currentAudioIndex++;
    if (currentAudioIndex >= currentAlbums.length) {
      currentAudioIndex = 0;
    }
    playAudio(currentAlbums[currentAudioIndex], currentAudioIndex, 'album');
  }
}

function skipBackward() {
  if (!audio.src) return;

  const newTime = Math.max(0, audio.currentTime - 10);
  audio.currentTime = newTime;

  if (currentRoom) {
    socket.emit('seek', {
      room: currentRoom,
      timestamp: newTime
    });
  }
}

function skipForward() {
  if (!audio.src) return;

  const newTime = Math.min(audio.duration, audio.currentTime + 10);
  audio.currentTime = newTime;

  if (currentRoom) {
    socket.emit('seek', {
      room: currentRoom,
      timestamp: newTime
    });
  }
}

function updateProgress() {
  if (!audio.duration) return;

  const progress = (audio.currentTime / audio.duration) * 100;
  elements.progress.style.width = `${progress}%`;
  elements.currentTime.textContent = formatTime(audio.currentTime);
}

function seekAudio(e) {
  if (!audio.duration) {
    console.log('Keine Dauer verfügbar für Seek');
    return;
  }

  const width = this.clientWidth;
  const clickX = e.offsetX;
  const duration = audio.duration;
  const newTime = (clickX / width) * duration;

  console.log('Seek zu:', newTime);
  isSeeking = true;
  audio.currentTime = newTime;

  if (currentRoom) {
    console.log('Sende Seek-Event:', newTime);
    socket.emit('seek', {
      room: currentRoom,
      timestamp: newTime
    });
  }

  setTimeout(() => { isSeeking = false; }, 100);
}

function createRoom() {
  const roomId = `room-${Math.random().toString(36).substr(2, 9)}`;
  joinRoom(roomId);
  showSuccess(`Raum ${roomId} erstellt`);
}

function joinRoom(roomId) {
  if (currentRoom === roomId) return;

  if (currentRoom) {
    leaveRoom();
  }

  currentRoom = roomId;
  socket.emit('join-room', roomId);
  elements.roomInfo.classList.remove('hidden');
  elements.roomName.textContent = `Raum: ${roomId}`;
  showSuccess(`Raum ${roomId} beigetreten`);
}

function leaveRoom() {
  if (!currentRoom) return;

  socket.emit('leave-room');
  audio.pause();
  audio.src = '';
  elements.currentTrackTitle.textContent = 'Kein Titel ausgewählt';
  elements.currentTrackArtist.textContent = 'MP3 Sync';
  elements.currentTrackImage.innerHTML = '<i class="fas fa-music"></i>';
  elements.duration.textContent = '0:00';
  elements.playBtn.innerHTML = '<i class="fas fa-play"></i>';
  elements.chapterList.innerHTML = '';
  elements.chapterList.classList.add('hidden');
  elements.roomInfo.classList.add('hidden');
  currentRoom = null;
  masterPeer = null;
  isUserInitiated = false;
  currentChapters = [];
  showSuccess('Raum verlassen');
}

function updateRoomMembers(members) {
  elements.roomMembers.innerHTML = '';
  members.forEach(member => {
    const memberElement = document.createElement('div');
    memberElement.className = 'room-member';
    memberElement.innerHTML = `
      <img src="${member.profileImage || '/default-profile.png'}" class="friend-img">
      <span>${member.username}</span>
    `;
    elements.roomMembers.appendChild(memberElement);
  });
}

function inviteFriendToRoom(friendId) {
  if (!currentRoom) {
    createRoom();
  }
  socket.emit('invite-friend', {
    friendId,
    roomId: currentRoom
  });
  elements.inviteModal.classList.remove('active');
  showSuccess('Einladung gesendet');
}

function showError(message) {
  const errorElement = document.createElement('div');
  errorElement.className = 'error-message';
  errorElement.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${message}`;
  document.body.appendChild(errorElement);
  setTimeout(() => {
    errorElement.remove();
  }, 5000);
}

function showSuccess(message) {
  const successElement = document.createElement('div');
  successElement.className = 'success-message';
  successElement.innerHTML = `<i class="fas fa-check-circle"></i> ${message}`;
  document.body.appendChild(successElement);
  setTimeout(() => {
    successElement.remove();
  }, 3000);
}

document.addEventListener('DOMContentLoaded', init);