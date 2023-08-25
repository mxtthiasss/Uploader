const express = require('express');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const Vibrant = require('node-vibrant');
const { removeMetadata, base64StringToArrayBuffer } = require('@qoocollections/content-metadata-remover');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

require('dotenv').config();
const {BASE_URL, PORT, JWT_TOKEN, SITE_TITLE, SITE_FAVICON, OG_TITLE, OG_DESCRIPTION, THEME_COLOR, DATABASE_HOST, DATABASE_PORT, DATABASE_USER, DATABASE_PASSWORD, DATABASE_DATABASE, AUTHOR_URL, AUTHOR_NAME, PROVIDER_NAME, PROVIDER_URL, DOMINANT_COLOR_STATIC, BOX_SHADOW_COLOR, COPYRIGHT_TEXT, DISCORD_WEBHOOK_NAME, DISCORD_WEBHOOK_URL, DISCORD_WEBHOOK_SUCCESS_COLOR, DISCORD_WEBHOOK_ERROR_COLOR, REDIRECT_URL } = process.env
const AUDIO_FORMATS = process.env.AUDIO_FORMATS.split(',');
const VIDEO_FORMATS = process.env.VIDEO_FORMATS.split(',');
const IMAGE_FORMATS = process.env.IMAGE_FORMATS.split(',');
const USE_DOMINANT_COLOR = process.env.USE_DOMINANT_COLOR === 'true';
const REMOVE_METADATA = process.env.REMOVE_METADATA === 'true';

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/', (req, res) => {
  res.status(302).location(REDIRECT_URL).json({});
});

function parseColor(hexColor) {
  return parseInt(hexColor, 16);
}

const pgClient = new Client({
  user: DATABASE_USER,
  host: DATABASE_HOST,
  database: DATABASE_DATABASE,
  password: DATABASE_PASSWORD,
  port: DATABASE_PORT
});

pgClient.connect((pgError) => {
  if (pgError) {
    console.error('[ERROR] | » Fehler bei der Verbindung zur PostgreSQL:', pgError);
    return;
  }
  console.log('[INFO] | » Die Verbindung zur PostgreSQL wurde erfolgreich hergestellt.');

  const createTableQuery = `CREATE TABLE IF NOT EXISTS file_data (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    creation_date VARCHAR(255) NOT NULL,
    size_mb DECIMAL(10, 3) NOT NULL,
    size_bytes INT NOT NULL,
    dominant_color VARCHAR(7) NOT NULL,
    resolution_width INT NOT NULL,
    resolution_height INT NOT NULL
  )`;

  pgClient.query(createTableQuery, (error, results) => {
    if (error) {
      console.error('[ERROR] | » Fehler beim Erstellen der Tabelle "file_data":', error);
    } else {
      console.log('[INFO] | » Tabelle "file_data" erfolgreich erstellt oder bereits vorhanden.');
    }
  });
});

const createDirectoriesForAllUsers = async () => {
  try {
    const users = await getAllUsers();

    users.forEach(user => {
      const uploadPath = path.join(__dirname, 'uploads', user.username);
      fs.mkdirSync(uploadPath, { recursive: true });

      const userPreviewPath = path.join(uploadPath, 'preview');
      fs.mkdirSync(userPreviewPath, { recursive: true });
    });

    console.log('[INFO] | » Alle Benutzerordner wurden erstellt.');
    const webhookData = {
      embeds: [
        {
          title: 'System',
          description: 'Alle Benutzerordner wurden erfolgreich erstellt.',
          color: parseColor(DISCORD_WEBHOOK_SUCCESS_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }

  } catch (error) {
    console.error('[ERROR] | » Fehler beim Erstellen der Benutzerordner:', error);
    const webhookData = {
      embeds: [
        {
          title: 'System',
          description: 'Fehler beim Erstellen der Benutzerordner\n' + error,
          color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }
  }
};

const getAllUsers = () => {
  return new Promise((resolve, reject) => {
    pgClient.query('SELECT username FROM users', (error, results) => {
      if (error) {
        reject(error);
      } else {
        resolve(results.rows);
      }
    });
  });
};

createDirectoriesForAllUsers();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const username = req.user.username;
    const uploadPath = path.join(__dirname, 'uploads', username);
    fs.mkdirSync(uploadPath, { recursive: true });

    const userPreviewPath = path.join(__dirname, 'uploads', username, 'preview');
    fs.mkdirSync(userPreviewPath, { recursive: true });

    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = uuidv4();
    const fileExtension = path.extname(file.originalname);
    const fileName = `${uniqueSuffix}${fileExtension}`;
    cb(null, fileName);
  },
});

const fileFilter = (req, file, cb) => {
  cb(null, true);
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
}).single('file');

const getUserByUsername = (username) => {
  return new Promise((resolve, reject) => {
    const query = 'SELECT * FROM users WHERE username = $1';
    const values = [username];

    pgClient.query(query, values, (error, results) => {
      if (error) {
        reject(error);
      } else {
        const user = results.rows[0];
        resolve(user);
      }
    });
  });
};

const generateToken = async (user) => {
  const payload = {
    id: user.id,
    username: user.username,
  };

  const token = jwt.sign(payload, JWT_TOKEN);

  const updateUserQuery = 'UPDATE users SET token = $1 WHERE id = $2';
  const updateValues = [token, user.id];
  pgClient.query(updateUserQuery, updateValues, (error) => {
    if (error) throw error;
  });

  return token;
};

const getUserByToken = (token) => {
  return new Promise((resolve, reject) => {
    const query = 'SELECT * FROM users WHERE token = $1';
    const values = [token];

    pgClient.query(query, values, (error, results) => {
      if (error) {
        console.error('[ERROR] | » Fehler beim Abrufen des Benutzers aus der Datenbank:', error);
        reject(error);
      } else {
        const user = results.rows[0];
        resolve(user);
      }
    });
  });
};

const authenticate = async (req, res, next) => {
  const token = req.headers['authorization'];

  if (!token) {
    return res.status(401).json({ error: 'Authentifizierungstoken fehlt!' });
  }

  try {
    const decoded = jwt.verify(token, JWT_TOKEN);
    req.user = decoded;

    const user = await getUserByUsername(decoded.username);
    if (!user || user.token !== token) {
      return res.status(401).json({ error: 'Ungültiges Token!' });
    }

    next();
  } catch (error) {
    console.error('[ERROR] | » Fehler bei der Authentifizierung:', error);
    res.status(401).json({ error: 'Ungültiges Token!' });
  }
};

const isAdmin = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ error: 'Authentifizierung fehlgeschlagen' });
  }

  try {
    const user = await getUserByToken(token);

    if (!user) {
      return res.status(401).json({ error: 'Ungültiges Token' });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Zugriff verweigert' });
    }

    next();
  } catch (error) {
    console.error('[ERROR] | » Fehler bei der Authentifizierung:', error);
    return res.status(500).json({ error: 'Serverfehler bei der Authentifizierung' });
  }
};

const comparePasswords = (password, hash) => {
  return bcrypt.compareSync(password, hash);
};

app.post('/login', async (req, res) => {
  const username = req.body.username;
  const password = req.body.password;

  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich!' });
  }

  try {
    const user = await getUserByUsername(username);

    if (!user || !comparePasswords(password, user.password)) {
      return res.status(400).json({ error: 'Ungültiger Benutzername oder Passwort!' });
    }

    res.json({ token: user.token, role: user.role });
  } catch (error) {
    console.error('[ERROR] | » Fehler bei der Anmeldung:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

const TokenUsername = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ error: 'Authentifizierung fehlgeschlagen' });
  }

  try {
    const user = await getUserByToken(token);

    if (!user) {
      return res.status(401).json({ error: 'Ungültiges Token' });
    }

    const username = user.username;
    req.TokenUsername = username;

    next();
  } catch (error) {
    console.error('[ERROR] | » Fehler bei der Authentifizierung:', error);
    return res.status(500).json({ error: 'Serverfehler bei der Authentifizierung' });
  }
};

const notFoundPage = `
<html>
<head>
  <title>404 » ${SITE_TITLE} </title>
  <meta property="og:title" content="${OG_TITLE}">
  <meta property="og:description" content="${OG_DESCRIPTION}">
  <link rel="icon" href="${SITE_FAVICON}" type="image/png" />
  <style>
  body {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100vh;
    background: #18191D;
    margin: 0;
    font-family: Arial, sans-serif;
    animation: bgAnimation 5s infinite alternate;
  }
  
    .button-container {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    .button {
        width: 220px;
        height: 50px;
        font-size: 15px;
        font-family: Arial, sans-serif;
        font-weight: bold;
        border: none;
        outline: none;
        color: #fff;
        background: #111;
        cursor: pointer;
        position: relative;
        z-index: 0;
        border-radius: 10px;
    }
    
    .button:before {
        content: '';
        background: linear-gradient(45deg, #ff0000, #ff7300, #fffb00, #48ff00, #00ffd5, #002bff, #7a00ff, #ff00c8, #ff0000);
        position: absolute;
        top: -2px;
        left:-2px;
        background-size: 400%;
        z-index: -1;
        filter: blur(5px);
        width: calc(100% + 4px);
        height: calc(100% + 4px);
        animation: glowing 20s linear infinite;
        opacity: 0;
        transition: opacity .3s ease-in-out;
        border-radius: 10px;
    }
    
    .button:active {
        color: #000
    }
    
    .button:active:after {
        background: transparent;
    }
    
    .button:hover:before {
        opacity: 1;
    }
    
    .button:after {
        z-index: -1;
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        background: #111;
        left: 0;
        top: 0;
        border-radius: 10px;
    }
    
    @keyframes glowing {
        0% { background-position: 0 0; }
        50% { background-position: 400% 0; }
        100% { background-position: 0 0; }
    }
    .text {
        font-size: 2rem;
        font-family: Arial, sans-serif;
        font-weight: bold;
        color: transparent;
        text-align: center;
        -webkit-background-clip: text;
        background-clip: text;
        background-image: linear-gradient(to right, #3B82F6, #A855F7, #F43F5E);
      }
    .copyright {
        position: absolute;
        bottom: 10px;
        font-size: 15px;
        font-family: Arial, sans-serif;
        font-weight: bold;
        color: #434552;
        text-align: center;
    }
    a {
        color: #434552;
    }
  </style>
</head>
<body>
  <h1 class="text">Diese Datei existiert nicht!</h1><br>
  <div class="button-container">
    <button class="button" type="button" onclick="javascript:history.back()">Zurück</button>
  </div>
  <div class="copyright">
    ${COPYRIGHT_TEXT}
  </div>
</body>
</html>`;

app.post('/upload', authenticate, upload, TokenUsername, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Keine Datei hochgeladen!' });
  }

  const filename = req.file.filename;
  const userUploadsPath = path.join(__dirname, 'uploads', req.TokenUsername);
  const filePath = path.join(userUploadsPath, filename);
  const previewPath = path.join(userUploadsPath, 'preview', filename);

  if (IMAGE_FORMATS.some(format => filename.endsWith(format))) {
    await sharp(filePath)
      .webp({ quality: 50 })
      .toFile(previewPath);
  }

  if (REMOVE_METADATA) {
  await removeMetadataFromImage(filePath);
  } else {
    console.log('[INFO] | » Metadatenentfernung deaktiviert.');
  }

  res.json({
    success: true,
    file: `${BASE_URL}/uploads/${req.TokenUsername}/${filename}`,
    view: `${BASE_URL}/view/${filename}`,
    preview: IMAGE_FORMATS.some(format => filename.endsWith(format))
      ? `${BASE_URL}/uploads/${req.TokenUsername}/preview/${filename}`
      : `${BASE_URL}/uploads/${req.TokenUsername}/${filename}`,
    delete: `${BASE_URL}/delete/${filename}`,
  });

  const imagePath = `./uploads/${req.TokenUsername}/${filename}`;

  const COLOR_COUNT = 256;
  const QUALITY = 3;

  const extractDominantColor = (imagePath) => {
    return new Promise((resolve, reject) => {
      const imageMimeType = getMimeType(imagePath);
      if (!isImageMimeType(imageMimeType)) {
        resolve('#ffffff');
        return;
      }

      Vibrant.from(imagePath)
        .maxColorCount(COLOR_COUNT)
        .quality(QUALITY)
        .getPalette()
        .then(palette => {
          const dominantColor = palette.Vibrant.hex;
          resolve(dominantColor);
        })
        .catch(error => {
          console.error('[ERROR] | » Fehler beim Extrahieren der Farbe:', error);
          reject(error);
        });
    });
  };

  function isImageMimeType(mimeType) {
    return mimeType.startsWith('image/png', 'image/jpeg', 'image/gif', 'image/tiff', 'image/bmp', 'image/tiff');
  }

  const getMimeType = (filePath) => {
    const mime = require('mime-types');
    const fs = require('fs');

    const mimeType = mime.lookup(filePath);
    return mimeType;
  };

let dominantColor;
if (USE_DOMINANT_COLOR === true) {
  dominantColor = await extractDominantColor(imagePath);
} else {
  dominantColor = DOMINANT_COLOR_STATIC;
}

  const fileStats = fs.statSync(filePath);
  const creationDate = fileStats.birthtime.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Berlin'
  });

  const isImage = IMAGE_FORMATS.some(format => filename.endsWith(format)) || filename.endsWith('.gif');
  const isVideo = VIDEO_FORMATS.some(format => filename.endsWith(format));

  let resolution;
  if (isImage) {
    try {
      resolution = await getImageResolution(filePath);
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Ermitteln der Bildauflösung:', error);
      resolution = { width: 0, height: 0 };
    }
  } else if (isVideo) {
    try {
      resolution = await getVideoResolution(filePath);
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Ermitteln der Videoauflösung:', error);
      resolution = { width: 0, height: 0 };
    }
  } else {
    resolution = { width: 0, height: 0 };
  }

  function getVideoResolution(filePath) {
    return new Promise((resolve, reject) => {
      if (!isVideoMimeType(getMimeType(filePath))) {
        reject(new Error('Keine Videodatei'));
      } else {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) {
            reject(err);
          } else {
            const { width, height } = metadata.streams[0];
            resolve({ width, height });
          }
        });
      }
    });
  }

  async function getImageResolution(filePath) {
    const metadata = await sharp(filePath).metadata();
    return { width: metadata.width, height: metadata.height };
  }

  const sizeInBytes = fileStats.size;
  const sizeInMB = parseFloat((sizeInBytes / (1024 * 1024)).toFixed(3));

  const saveFileDataToDatabase = async (username, filename, creationDate, sizeInMB, sizeInBytes, dominantColor, resolution) => {
    const query = 'INSERT INTO file_data (username, filename, creation_date, size_mb, size_bytes, dominant_color, resolution_width, resolution_height) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
    const values = [username, filename, creationDate, sizeInMB, sizeInBytes, dominantColor, resolution.width, resolution.height];
  
    pgClient.query(query, values, async (error, results) => {
      if (error) {
        console.error('[ERROR] | » Fehler beim Speichern der Dateidaten in die Datenbank:', error);
  
        const webhookData = {
          embeds: [
            {
              title: 'Neue Datei hochgeladen',
              description: 'Fehler beim Speichern der Dateidaten in die Datenbank\n' + error,
              color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
            }
          ],
          username: DISCORD_WEBHOOK_NAME,
        };
  
        try {
          await axios.post(DISCORD_WEBHOOK_URL, webhookData);
          console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
        } catch (error) {
          console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
        }
      } else {
        console.log('[INFO] | » Dateidaten erfolgreich in die Datenbank gespeichert.');
  
        const webhookData = {
          embeds: [
            {
              title: 'Neue Datei hochgeladen',
              description: 'Dateidaten erfolgreich in die Datenbank gespeichert.',
              color: parseColor(DISCORD_WEBHOOK_SUCCESS_COLOR),
            }
          ],
          username: DISCORD_WEBHOOK_NAME,
        };
  
        try {
          await axios.post(DISCORD_WEBHOOK_URL, webhookData);
          console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
        } catch (error) {
          console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
        }
      }
    });
  };

  saveFileDataToDatabase(req.user.username, filename, creationDate, sizeInMB, sizeInBytes, dominantColor, resolution);
  const webhookData = {
    embeds: [
      {
        title: 'Neue Datei hochgeladen',
        description: 'Dateiname: **' + filename + `**\nURL: **${BASE_URL}/view/${filename}` + '**\nBenutzername: **' + req.user.username + '**\nGröße: **' + sizeInMB + 'MB**\nAuflösung: **' + resolution.width + 'x' + resolution.height + '**\nHauptfarbe: **' + dominantColor + '**',
        color: parseColor(DISCORD_WEBHOOK_SUCCESS_COLOR),
      }
    ],
    username: DISCORD_WEBHOOK_NAME,
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, webhookData);
    console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
  }
});

const removeMetadataFromImage = async (filePath) => {
  const read = async (size, offset) => {
    return new Promise((resolve, reject) => {
      fs.open(filePath, 'r', (error, fd) => {
        if (error) {
          reject(error);
        } else {
          const buffer = Buffer.alloc(size);
          fs.read(fd, buffer, 0, size, offset, (error, bytesRead, buffer) => {
            if (error) {
              reject(error);
            } else {
              resolve(base64StringToArrayBuffer(buffer.toString('base64')));
            }
            fs.close(fd, () => { });
          });
        }
      });
    });
  };

  const write = async (writeValue, entryOffset, encoding) => {
    return new Promise((resolve, reject) => {
      fs.open(filePath, 'r+', (error, fd) => {
        if (error) {
          reject(error);
        } else {
          const buffer = Buffer.from(writeValue, encoding);
          fs.write(fd, buffer, 0, buffer.length, entryOffset, (error, bytesWritten, buffer) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
            fs.close(fd, () => { });
          });
        }
      });
    });
  };

  try {
    await removeMetadata(filePath, read, write);
    console.log('[INFO] | » Metadaten erfolgreich entfernt.');
    const webhookData = {
      embeds: [
        {
          title: 'Neue Datei hochgeladen',
          description: 'Metadaten erfolgreich entfernt.',
          color: parseColor(DISCORD_WEBHOOK_SUCCESS_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Entfernen der Metadaten:', error);
    const webhookData = {
      embeds: [
        {
          title: 'Neue Datei hochgeladen',
          description: 'Fehler beim Entfernen der Metadaten!\nFehler:' + error,
          color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }
  }
};

const getFileDataFromDatabase = async (username, filename) => {
  return new Promise(async (resolve, reject) => {
    const query = 'SELECT * FROM file_data WHERE username = $1 AND filename = $2';
    const values = [username, filename];

    pgClient.query(query, values, async (error, results) => {
      if (error) {
        console.error('[ERROR] | » Fehler beim Abrufen der Dateidaten aus der Datenbank:', error);

        const webhookData = {
          embeds: [
            {
              title: 'Neue Datei hochgeladen',
              description: 'Fehler beim Abrufen der Dateidaten aus der Datenbank\n' + error,
              color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
            }
          ],
          username: DISCORD_WEBHOOK_NAME,
        };

        try {
          await axios.post(DISCORD_WEBHOOK_URL, webhookData);
          console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
        } catch (error) {
          console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
        }
        reject(error);
      } else {
        if (results.rows.length > 0) {
          resolve(results.rows[0]);
        } else {
          resolve(null);
        }
      }
    });
  });
};

const getFileByFilename = async (filename) => {
  return new Promise(async (resolve, reject) => {
    const query = 'SELECT * FROM file_data WHERE filename = $1';
    const values = [filename];

    pgClient.query(query, values, async (error, results) => {
      if (error) {
        console.error('[ERROR] | » Fehler beim Abrufen der Dateidaten aus der Datenbank:', error);
        reject(error);
      } else {
        if (results.rows.length > 0) {
          resolve(results.rows[0]);
        } else {
          resolve(null);
        }
      }
    });
  });
};

app.get('/view/:filename', async (req, res) => {
  const filename = req.params.filename;

  try {
    const file = await getFileByFilename(filename);

    if (!file) {
      return res.status(404).send(notFoundPage);
    }
    const username = file.username;

    const filePath = path.join(__dirname, 'uploads', username, filename);
    fs.access(filePath, fs.constants.F_OK, (err) => {
      if (err) {
        return res.status(404).send(notFoundPage);
      }
      let filename = req.params.filename;
      let filePath = path.join(__dirname, 'uploads', username, filename);
      let previewPath = path.join(__dirname, 'uploads', username, 'preview', filename);

      fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
          return res.status(404).send(notFoundPage);
        }

        getFileDataFromDatabase(username, filename)
          .then(fileData => {
            if (!fileData) {
              return res.status(404).send({ error: 'Keine Dateiinformationen in der Datenbank gefunden!' });
            }

            const sizeInMB = fileData.size_mb
            const creationDate = fileData.creation_date.toLocaleString('de-DE', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              timeZone: 'Europe/Berlin'
            });

            const resolution = fileData.resolution_width + 'x' + fileData.resolution_height;
            const resolutionHTML = fileData.resolution_width !== 0 && fileData.resolution_height !== 0 ? `Auflösung: ${resolution}` : '';

            const isImage = IMAGE_FORMATS.some(format => filename.endsWith(format)) || filename.endsWith('.gif');
            const isImageWithGif = IMAGE_FORMATS.some(format => filename.endsWith(format));
            const isAudio = AUDIO_FORMATS.some(format => filename.endsWith(format));
            const isVideo = VIDEO_FORMATS.some(format => filename.endsWith(format));


            let metaTag = '';

            if (isImage) {
              metaTag = `<meta property="og:image" content="${BASE_URL}/uploads/${username}/${filename}" />
          <meta property="og:type" content="image.other"/>
          <meta property="og:image" content="${BASE_URL}/uploads/${username}/${filename}" />
          <meta property="og:image:secure_url" content="${BASE_URL}/uploads/${username}/${filename}" />
          <meta property="og:image:type" content="image.other" />
          <meta property="og:image:alt" content="BILD" />
          <meta property="og:image:width" content="${fileData.resolution_width}" />
          <meta property="og:image:height" content="${fileData.resolution_height}" />
          <meta name="twitter:card" content="summary_large_image">`;

            } else if (isVideo) {
              metaTag = `<meta property="og:video" content="${BASE_URL}/uploads/${username}/${filename}" />
          <meta property="og:video:secure_url" content="${BASE_URL}/uploads/${username}/${filename}" />
          <meta property="og:type" content="video.other"/>
          <meta property="og:video:width" content="${fileData.resolution_width}" />
          <meta property="og:video:height" content="${fileData.resolution_height}" />`;
            } else if (isAudio) {
              metaTag = `<meta property="og:audio" content="${BASE_URL}/uploads/${username}/${filename}" />
          <meta property="og:audio:secure_url" content="${BASE_URL}/uploads/${username}/${filename}" />
          <meta property="og:audio:type" content="audio.other" />`;

            }

            let themeColor = '#ffffff';

            if (THEME_COLOR.includes('&dominantColor')) {
              const dominantColor = fileData ? fileData.dominant_color : null;
              themeColor = dominantColor;
            } else {
              themeColor = THEME_COLOR;
            }

            if (isImageWithGif) {
              getFileDataFromDatabase(username, filename)
                .then(fileData => {
                  const dominantColor = fileData ? fileData.dominant_color : null;
                  const cssCode = `box-shadow: 0px 60px 100px 0px ${dominantColor}, 0px 45px 26px 0px rgba(0,0,0,0.14);`;
                  sendHtmlResponse(cssCode);
                })
                .catch(async error => {
                  console.error('[ERROR] | » Fehler beim Abrufen der Dateidaten aus der Datenbank:', error);
                  const webhookData = {
                    embeds: [
                      {
                        title: 'Neue Datei hochgeladen',
                        description: 'Fehler beim Abrufen der Dateidaten aus der Datenbank\n' + error,
                        color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
                      }
                    ],
                    username: DISCORD_WEBHOOK_NAME,
                  };

                  try {
                    await axios.post(DISCORD_WEBHOOK_URL, webhookData);
                    console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
                  } catch (error) {
                    console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
                  }

                  const cssCode = `box-shadow: 0px 60px 100px 0px #${BOX_SHADOW_COLOR}, 0px 45px 26px 0px rgba(0,0,0,0.14);`;
                  sendHtmlResponse(cssCode);
                });
            } else {
              const cssCode = `box-shadow: 0px 60px 100px 0px #${BOX_SHADOW_COLOR}, 0px 45px 26px 0px rgba(0,0,0,0.14);`;
              sendHtmlResponse(cssCode);
            }

            function sendHtmlResponse(cssCode) {
              const htmlResponse = `          
      <html>
        <head>
          <title>${SITE_TITLE}</title>
          ${metaTag}
          <meta property="og:title" content="${OG_TITLE}">
          <meta property="og:description" content="${OG_DESCRIPTION}">
          <meta name="theme-color" content="${themeColor}">
          <link rel="icon" href="${SITE_FAVICON}" type="image/png" />
          <link href="${BASE_URL}/oembed/${filename}" title="oEmbed" rel="alternate" type="application/json+oembed" />
          <style>
          body {
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background: #18191D;
            margin: 0;
            font-family: Arial, sans-serif;
            animation: bgAnimation 5s infinite alternate;
          }
          
          .file-container {
            position: relative;
            max-width: 30%;
            width: auto;
            animation: rainbow 10s linear infinite;
            border-radius: 10px;
            ${cssCode}
          }
          
          img,
          video {
            width: 100%;
            max-width: 100%;
            height: auto;
            display: block;
            border-radius: 10px;
            max-height: 50vh;
          }
            .button-container {
              display: flex;
              gap: 10px;
              margin-top: 20px;
            }
            .button {
                width: 220px;
                height: 50px;
                font-size: 15px;
                font-family: Arial, sans-serif;
                font-weight: bold;
                border: none;
                outline: none;
                color: #fff;
                background: #111;
                cursor: pointer;
                position: relative;
                z-index: 0;
                border-radius: 10px;
            }
            
            .button:before {
                content: '';
                background: linear-gradient(45deg, #ff0000, #ff7300, #fffb00, #48ff00, #00ffd5, #002bff, #7a00ff, #ff00c8, #ff0000);
                position: absolute;
                top: -2px;
                left:-2px;
                background-size: 400%;
                z-index: -1;
                filter: blur(5px);
                width: calc(100% + 4px);
                height: calc(100% + 4px);
                animation: glowing 20s linear infinite;
                opacity: 0;
                transition: opacity .3s ease-in-out;
                border-radius: 10px;
            }
            
            .button:active {
                color: #000
            }
            
            .button:active:after {
                background: transparent;
            }
            
            .button:hover:before {
                opacity: 1;
            }
            
            .button:after {
                z-index: -1;
                content: '';
                position: absolute;
                width: 100%;
                height: 100%;
                background: #111;
                left: 0;
                top: 0;
                border-radius: 10px;
            }
            
            @keyframes glowing {
                0% { background-position: 0 0; }
                50% { background-position: 400% 0; }
                100% { background-position: 0 0; }
            }
            .filename {
                font-size: 2rem;
                font-family: Arial, sans-serif;
                font-weight: bold;
                color: transparent;
                text-align: center;
                -webkit-background-clip: text;
                background-clip: text;
                background-image: linear-gradient(to right, #3B82F6, #A855F7, #F43F5E);
              }
            .stats {
              font-size: 20px;
              font-family: Arial, sans-serif;
              font-weight: bold;
              color: #434552;
              text-align: center;
              margin-top: 65px;
            }
            .copyright {
                position: absolute;
                bottom: 10px;
                font-size: 15px;
                font-family: Arial, sans-serif;
                font-weight: bold;
                color: #434552;
                text-align: center;
            }
            a {
                color: #434552;
            }
          </style>
        </head>
        <body>
          <h1 class="filename">${filename}</h1><br>
          <div class="file-container">
            ${isAudio
                  ? `<audio controls>
                  <source src="/uploads/${username}/${filename}">
                </audio>`
                  : (isVideo)
                    ? `<video controls>
                    <source src="/uploads/${username}/${filename}">
                  </video>`
                    : (filename.endsWith('.gif'))
                      ? `<img src="/uploads/${username}/${filename}" alt="GIF" />`
                      : (fs.existsSync(previewPath)
                        ? `<img src="/uploads/${username}/preview/${filename}" alt="Preview" />`
                        : `<img src="${BASE_URL}/assets/file.png" alt="Datei" />`
                      )
                }
          </div>
          <div class="button-container">
            <button class="button" type="button" onclick="window.open('/download/${filename}')">Herunterladen</button>
            <button class="button" type="button" onclick="window.location.href = '/uploads/${username}/${filename}';">Direct Link</button>
          </div>
          <div class="stats">
            Hochgeladen von: ${username}<br>
            Hochgeladen am: ${creationDate}<br>
            Größe der Datei: ${sizeInMB} MB<br>
            ${resolutionHTML}
          </div>
          <div class="copyright">
            ${COPYRIGHT_TEXT}
          </div>
        </body>
      </html>`;
              res.send(htmlResponse);
            }
          });
      });
    });
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Abrufen der Datei:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

app.get('/oembed/:filename', async (req, res) => {
  const filename = req.params.filename;

  try {
    const file = await getFileByFilename(filename);

    if (!file) {
      return res.status(404).send(notFoundPage);
    }
    const username = file.username;
    const fileData = await getFileDataFromDatabase(username, filename);

    const filePath = path.join(__dirname, 'uploads', username, filename);
    fs.access(filePath, fs.constants.F_OK, (err) => {
      if (err) {
        return res.status(404).send(notFoundPage);
      }

      const isImage = IMAGE_FORMATS.some(format => filename.endsWith(format));
      const isAudio = AUDIO_FORMATS.some(format => filename.endsWith(format));
      const isVideo = VIDEO_FORMATS.some(format => filename.endsWith(format));

      let type = 'file';
      if (isImage) {
        type = 'image';
      } else if (isVideo) {
        type = 'video';
      } else if (isAudio) {
        type = 'audio';
      }

      let oembedResponse = {
        type,
        version: '1.0',
        title: filename,
        author_url: AUTHOR_URL,
        author_name: AUTHOR_NAME,
        url: `${BASE_URL}/view/${filename}`,
        width: fileData.resolution_width,
        height: fileData.resolution_height,
        provider_name: PROVIDER_NAME,
        provider_url: PROVIDER_URL,
        html: `<iframe src="${BASE_URL}/uploads/${username}/${filename}" width="${fileData.resolution_width}" height="${fileData.resolution_height}" frameborder="0"></iframe>`
      };

      res.json(oembedResponse);
    });
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Abrufen der Datei:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

app.get('/download/:filename', async (req, res) => {
  const filename = req.params.filename;

  try {
    const file = await getFileByFilename(filename);

    if (!file) {
      return res.status(404).send(notFoundPage);
    }

    const username = file.username;
    const filePath = path.join(__dirname, 'uploads', username, filename);

    fs.access(filePath, fs.constants.F_OK, (err) => {
      if (err) {
        return res.status(404).send(notFoundPage);
      }

      res.download(filePath);
    });
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Abrufen der Datei:', error);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

app.delete('/delete-user/:username', isAdmin, TokenUsername, async (req, res) => {
  const username = req.params.username;

  try {
    const checkUserQuery = 'SELECT * FROM users WHERE username = $1';
    const checkUserValues = [username];

    const userCheckResult = await pgClient.query(checkUserQuery, checkUserValues);

    if (userCheckResult.rows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }

    const deleteQuery = 'DELETE FROM users WHERE username = $1';
    const deleteValues = [username];

    await pgClient.query(deleteQuery, deleteValues);

    console.log('[INFO] | » Nutzer erfolgreich aus der Datenbank gelöscht.');

    const userFolderPath = path.join(__dirname, 'uploads', username);
    if (fs.existsSync(userFolderPath)) {
      fs.rmdirSync(userFolderPath, { recursive: true });
      console.log('[INFO] | » Nutzerordner erfolgreich gelöscht.');
    }

    const deleteFilesQuery = 'DELETE FROM file_data WHERE username = $1';
    await pgClient.query(deleteFilesQuery, deleteValues);

    console.log('[INFO] | » Dateieinträge erfolgreich aus der Datenbank gelöscht.');

    const webhookData = {
      embeds: [
        {
          title: 'Ein Nutzer wurde gelöscht',
          description: 'Nutzername: **' + req.user.username,
          color: parseColor(DISCORD_WEBHOOK_SUCCESS_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }

    res.json({ success: true, message: 'Nutzer erfolgreich gelöscht' });

  } catch (error) {
    console.error('[ERROR] | » Fehler beim Löschen des Nutzers:', error);

    const webhookData = {
      embeds: [
        {
          title: 'Ein Nutzer löschen',
          description: '\n' + error,
          color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }

    res.status(500).json({ error: 'Fehler beim Löschen des Nutzers' });
  }
});

app.delete('/delete-user', authenticate, TokenUsername, async (req, res) => {
  const username = req.TokenUsername;

  try {
    const deleteQuery = 'DELETE FROM users WHERE username = $1';
    const deleteValues = [username];

    pgClient.query(deleteQuery, deleteValues, async (error, results) => {
      if (error) {
        console.error('[ERROR] | » Fehler beim Löschen des Nutzers aus der Datenbank:', error);

        const webhookData = {
          embeds: [
            {
              title: 'Ein Nutzer wurde gelöscht',
              description: '\n' + error,
              color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
            }
          ],
          username: DISCORD_WEBHOOK_NAME,
        };

        try {
          await axios.post(DISCORD_WEBHOOK_URL, webhookData);
          console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
        } catch (error) {
          console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
        }

        res.status(500).json({ error: 'Fehler beim Löschen des Nutzers' });
      } else {
        console.log('[INFO] | » Nutzer erfolgreich aus der Datenbank gelöscht.');

        const userFolderPath = path.join(__dirname, 'uploads', username);
        if (fs.existsSync(userFolderPath)) {
          fs.rmdirSync(userFolderPath, { recursive: true });
          console.log('[INFO] | » Nutzerordner erfolgreich gelöscht.');
        }

        const deleteFilesQuery = 'DELETE FROM file_data WHERE username = $1';
        pgClient.query(deleteFilesQuery, deleteValues, async (error) => {
          if (error) {
            console.error('[ERROR] | » Fehler beim Löschen der Dateieinträge aus der Datenbank:', error);
            const webhookData = {
              embeds: [
                {
                  title: 'Ein Nutzer wurde gelöscht',
                  description: '\n' + error,
                  color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
                }
              ],
              username: DISCORD_WEBHOOK_NAME,
            };

            try {
              await axios.post(DISCORD_WEBHOOK_URL, webhookData);
              console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
            } catch (error) {
              console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
            }
            res.status(500).json({ error: 'Fehler beim Löschen der Dateieinträge' });
          } else {
            console.log('[INFO] | » Dateieinträge erfolgreich aus der Datenbank gelöscht.');

            const webhookData = {
              embeds: [
                {
                  title: 'Ein Nutzer wurde gelöscht',
                  description: 'Der Nutzer ' + username + ' wurde erfolgreich gelöscht.',
                  color: parseColor(DISCORD_WEBHOOK_SUCCESS_COLOR),
                }
              ],
              username: DISCORD_WEBHOOK_NAME,
            };

            try {
              await axios.post(DISCORD_WEBHOOK_URL, webhookData);
              console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
            } catch (error) {
              console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
            }
            res.json({ success: true, message: 'Nutzer erfolgreich gelöscht' });
          }
        });
      }
    });
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Löschen des Nutzers:', error);
    const webhookData = {
      embeds: [
        {
          title: 'Ein Nutzer löschen',
          description: '\n' + error,
          color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }
    res.status(500).json({ error: 'Fehler beim Löschen des Nutzers' });
  }
});

const deleteFile = async (username, filename) => {
  let filePath = path.join(__dirname, 'uploads', username, filename);
  let previewPath = path.join(__dirname, 'uploads', username, 'preview', filename);

  if (!fs.existsSync(filePath)) {
    throw new Error('Datei nicht gefunden!');
  }

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  if (fs.existsSync(previewPath)) {
    fs.unlinkSync(previewPath);
  }

  const deleteQuery = 'DELETE FROM file_data WHERE username = $1 AND filename = $2';
  const deleteValues = [username, filename];

  return new Promise(async (resolve, reject) => {
    pgClient.query(deleteQuery, deleteValues, async (error) => {
      if (error) {
        console.error('[ERROR] | » Fehler beim Löschen des Eintrags aus der Datenbank:', error);
        const webhookData = {
          embeds: [
            {
              title: 'Eine Datei wurde gelöscht',
              description: '\n' + error,
              color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
            }
          ],
          username: DISCORD_WEBHOOK_NAME,
        };

        try {
          await axios.post(DISCORD_WEBHOOK_URL, webhookData);
          console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
        } catch (error) {
          console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
        }
        reject(error);
      } else {
        console.log('[INFO] | » Eintrag erfolgreich aus der Datenbank gelöscht.');
        const webhookData = {
          embeds: [
            {
              title: 'Eine Datei wurde gelöscht',
              description: 'Der Eintrag wurde erfolgreich aus der Datenbank gelöscht.',
              color: parseColor(DISCORD_WEBHOOK_SUCCESS_COLOR),
            }
          ],
          username: DISCORD_WEBHOOK_NAME,
        };

        try {
          await axios.post(DISCORD_WEBHOOK_URL, webhookData);
          console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
        } catch (error) {
          console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
        }
        resolve();
      }
    });
  });
};

app.delete('/delete-file/:username/:filename', authenticate, isAdmin, async (req, res) => {
  try {
    await deleteFile(req.params.username, req.params.filename);
    res.json({ success: true, message: 'Datei erfolgreich gelöscht' });
    const webhookData = {
      embeds: [
        {
          title: 'Eine Datei wurde gelöscht',
          description: 'Nutzername: **' + req.user.username + '**\nDatei: **' + req.params.filename + '**',
          color: parseColor(DISCORD_WEBHOOK_SUCCESS_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Löschen der Datei:', error);
    const webhookData = {
      embeds: [
        {
          title: 'Eine Datei löschen',
          description: '\n' + error,
          color: parseColor(DISCORD_WEBHOOK_ERROR_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }
    res.status(500).json({ error: 'Fehler beim Löschen der Datei' });
  }
});

app.delete('/delete-file/:filename', authenticate, TokenUsername, async (req, res) => {
  try {
    await deleteFile(req.TokenUsername, req.params.filename);
    res.json({ success: true, message: 'Datei erfolgreich gelöscht' });
    const webhookData = {
      embeds: [
        {
          title: 'Eine Datei wurde gelöscht',
          description: 'Nutzername: **' + req.TokenUsername + '**\nDatei: **' + req.params.filename + '**',
          color: parseColor(DISCORD_WEBHOOK_SUCCESS_COLOR),
        }
      ],
      username: DISCORD_WEBHOOK_NAME,
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, webhookData);
      console.log('[INFO] | » Webhook-Log erfolgreich an Discord gesendet.');
    } catch (error) {
      console.error('[ERROR] | » Fehler beim Senden des Webhook-Logs an Discord:', error);
    }
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Löschen der Datei:', error);
    res.status(500).json({ error: 'Fehler beim Löschen der Datei' });
  }
});

const getFilesInDirectory = (dirPath) => {
  return new Promise((resolve, reject) => {
    fs.readdir(dirPath, (error, files) => {
      if (error) {
        reject(error);
      } else {
        const filteredFiles = files.filter(file => file !== 'preview');
        resolve(filteredFiles);
      }
    });
  });
};

app.get('/files/:username', authenticate, isAdmin, async (req, res) => {
  try {
    const userDirPath = path.join(__dirname, 'uploads', req.params.username);
    const files = await getFilesInDirectory(userDirPath);
    res.json({ files });
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Abrufen der Dateien:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Dateien' });
  }
});

app.get('/files', authenticate, TokenUsername, async (req, res) => {
  try {
    const userDirPath = path.join(__dirname, 'uploads', req.TokenUsername);
    const files = await getFilesInDirectory(userDirPath);
    res.json({ files });
  } catch (error) {
    console.error('[ERROR] | » Fehler beim Abrufen der Dateien:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Dateien' });
  }
});

app.listen(PORT, () => console.log('[INFO] | » Server gestartet auf Port: ' + PORT));