const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  profileImage: {
    type: String,
    default: null
  },
  audioFiles: [{
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId()
    },
    path: String,
    originalName: String,
    title: String,
    artist: String,
    cover: String,
    duration: Number
  }],
  albums: [{
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId()
    },
    path: String,
    originalName: String,
    title: String,
    artist: String,
    cover: String,
    duration: Number,
    chapters: [{
      title: String,
      start: Number,
      end: Number
    }]
  }],
  friends: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  friendRequests: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  currentRoom: {
    type: String,
    default: null
  }
});

module.exports = mongoose.model('User', userSchema);