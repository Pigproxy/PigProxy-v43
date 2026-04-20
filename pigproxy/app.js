const express = require('express'),
  app = express(),
  http = require('http'),
  https = require('https'),
  fs = require('fs'),
  querystring = require('querystring'),
  session = require('express-session'),
  sanitizer = require('sanitizer'),
  websocket = require('./ws-proxy.js'),
  fetch = require('node-fetch');

const config = JSON.parse(fs.readFileSync('./config.json', {encoding:'utf8'})); 
if (!config.prefix.startsWith('/')) {
    config.prefix = `/${config.prefix}`;
}

if (!config.prefix.endsWith('/')) {
   config.prefix = `${config.prefix}/`;
}

let server;
let server_protocol;
const server_options = {
  key: fs.readFileSync(process.env.SSL_DEFAULT_KEY),
  cert: fs.readFileSync(process.env.SSL_DEFAULT_CERT)
}
if (config.ssl == true) { server = https.createServer(server_options, app); server_protocol = 'https://';}
else { server = http.createServer(app); server_protocol = 'http://';};

// WebSocket Proxying
websocket(server);

// Serve static files before other routes
app.use(express.static('public'));

console.log(`The Proxy now running on ${server_protocol}127.0.0.1:${config.port}! Proxy prefix is "${config.prefix}"!`);
server.listen(process.env.PORT || config.port, '0.0.0.0', () => {
  console.log(`Server is running at http://127.0.0.1:${config.port}`);
});

btoa = (str) => {
  str = new Buffer.from(str).toString('base64');
  return str;
};

atob = (str) => {
  str = new Buffer.from(str, 'base64').toString('utf-8');
  return str;
};

rewrite_url = (dataURL, option) => {
  var websiteURL;
  var websitePath;
  if (option == 'decode') {
     websiteURL = atob(dataURL.split('/').splice(0, 1).join('/'));
    websitePath = '/' + dataURL.split('/').splice(1).join('/');
  } else {
  websiteURL = btoa(dataURL.split('/').splice(0, 3).join('/'));
  websitePath = '/' + dataURL.split('/').splice(3).join('/');
  }
  if (websitePath == '/') { return `${websiteURL}`; } else return `${websiteURL}${websitePath}`;
};

app.use(session({
  secret: 'alloy',
  saveUninitialized: true,
  resave: true,
  cookie: { 
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));
// We made our own version of body-parser instead, due to issues.
app.use((req, res, next) => {
    if (req.method == 'POST') {
   req.raw_body = '';
   req.on('data', chunk => {
        req.raw_body += chunk.toString(); // convert Buffer to string
   });
   req.on('end', () => {
        req.str_body = req.raw_body;
        try {
            req.body = JSON.parse(req.raw_body);
        } catch(err) {
            req.body = {}
        }
       next();
   });
} else return next();
});

app.use(`${config.prefix}utils/`, async(req, res, next) => {
    if (req.url.startsWith('/assets/')){res.sendFile(__dirname + '/utils' + req.url);}
   if (req.query.url) {
      let url = atob(req.query.url);
      if (url.startsWith('https://') || url.startsWith('http://')) {
          url = url;
      } else if (url.startsWith('//')) {
          url = 'http:' + url; 
      } else {
        url = 'http://' + url;
      }
      return res.redirect(307, config.prefix + rewrite_url(url)); 
      }
});

app.post(`${config.prefix}session/`, async(req, res, next) => {
   let url = querystring.parse(req.raw_body).url.trim();
   // Remove any protocol if user entered it
   url = url.replace(/^https?:\/\//i, '');
   // Remove any paths, just keep the domain
   url = url.split('/')[0];
   // Add https protocol
   url = 'https://' + url;
   return res.redirect(config.prefix + rewrite_url(url));
});

app.use(config.prefix, async(req, res, next) => {
  var proxy = {};
  proxy.url = rewrite_url(req.url.slice(1), 'decode');
  proxy.url = {
    href: proxy.url,
    hostname : proxy.url.split('/').splice(2).splice(0, 1).join('/'),
    origin : proxy.url.split('/').splice(0, 3).join('/'),
    encoded_origin : btoa(proxy.url.split('/').splice(0, 3).join('/')),
    path : '/' + proxy.url.split('/').splice(3).join('/'),
    protocol : proxy.url.split('\:').splice(0, 1).join(''), 
  }

  proxy.url.encoded_origin = btoa(proxy.url.origin);

  proxy.requestHeaders = req.headers;
  proxy.requestHeaders['host'] = proxy.url.hostname;
  if (proxy.requestHeaders['referer']) {
    let referer =  '/' + String(proxy.requestHeaders['referer']).split('/').splice(3).join('/');

    referer = rewrite_url(referer.replace(config.prefix, ''), 'decode');

    if (referer.startsWith('https://') || referer.startsWith('http://')) {
      referer = referer;

    } else referer = proxy.url.href;

    proxy.requestHeaders['referer'] = referer;
  }


  if (proxy.requestHeaders['origin']) {
    let origin =  '/' + String(proxy.requestHeaders['origin']).split('/').splice(3).join('/');

    origin = rewrite_url(origin.replace(config.prefix, ''), 'decode');

    if (origin.startsWith('https://') || origin.startsWith('http://')) {

      origin = origin.split('/').splice(0, 3).join('/');

    } else origin = proxy.url.origin;

     proxy.requestHeaders['origin'] = origin;
  }
 if (proxy.requestHeaders.cookie) {
     delete proxy.requestHeaders.cookie;
  }
  const httpAgent = new http.Agent({
  keepAlive: true
  });
  const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true
  });
  proxy.options = {
    method: req.method,
    headers: proxy.requestHeaders,
    redirect: 'manual',
    agent: function(_parsedURL) {
    if (_parsedURL.protocol == 'http:') {
      return httpAgent;
      } else {
        return httpsAgent;
      }
    }
};

if (req.method == 'POST') {
    proxy.options.body = req.str_body;
}
if (proxy.url.hostname == 'discord.com' && proxy.url.path == '/') { return res.redirect(307, config.prefix + rewrite_url('https://discord.com/login'));};

if (proxy.url.hostname == 'www.reddit.com') { return res.redirect(307, config.prefix + rewrite_url('https://old.reddit.com'));};

if (!req.url.slice(1).startsWith(`${proxy.url.encoded_origin}/`)) { return res.redirect(307, config.prefix + proxy.url.encoded_origin + '/');};

const blocklist = JSON.parse(fs.readFileSync('./blocklist.json', {encoding:'utf8'}));	  

let is_blocked = false;	  

Array.from(blocklist).forEach(blocked_hostname => {
    if (proxy.url.hostname == blocked_hostname) {
        is_blocked = true;
    }
});

if (is_blocked == true) { return res.send(fs.readFileSync('./utils/error/error.html', 'utf8').toString().replace('%ERROR%', `Error 401: The website '${sanitizer.sanitize(proxy.url.hostname)}' is not permitted!`))}	  

proxy.response = await fetch(proxy.url.href, proxy.options).catch(err => res.send(fs.readFileSync('./utils/error/error.html', 'utf8').toString().replace('%ERROR%', `Error 400: Could not make request to '${sanitizer.sanitize(proxy.url.href)}'!`)));

if(typeof proxy.response.buffer != 'function')return;

proxy.buffer = await proxy.response.buffer();

proxy.content_type = 'text/plain';

proxy.response.headers.forEach((e, i, a) => {
    if (i == 'content-type') proxy.content_type = e;
  });
if (proxy.content_type == null || typeof proxy.content_type == 'undefined') proxy.content_type = 'text/html';

proxy.sendResponse = proxy.buffer;

 // Parsing the headers from the response to remove square brackets so we can set them as the response headers.
proxy.headers = Object.fromEntries(
    Object.entries(JSON.parse(JSON.stringify(proxy.response.headers.raw())))
      .map(([key, val]) => [key, val[0]])
 );

 // Parsing all the headers to remove all of the bad headers that could affect proxies performance.
 Object.entries(proxy.headers).forEach(([header_name, header_value]) => {
  if (header_name.startsWith('content-encoding') || header_name.startsWith('x-') || header_name.startsWith('cf-') || header_name.startsWith('strict-transport-security') || header_name.startsWith('content-security-policy')) {
      delete proxy.headers[header_name];
  }
 });

if (proxy.response.headers.get('location')) {
  return res.redirect(307, config.prefix + rewrite_url(String(proxy.response.headers.get('location'))));
}

res.status(proxy.response.status);
res.set(proxy.headers);
res.contentType(proxy.content_type);
if (proxy.content_type.startsWith('text/html')) {
    req.session.url = proxy.url.origin;
    proxy.sendResponse = proxy.sendResponse.toString()
   .replace(/integrity="(.*?)"/gi, '')
   .replace(/nonce="(.*?)"/gi, '')
   .replace(/(href|src|poster|data|action|srcset)="\/\/(.*?)"/gi, `$1` + `="http://` + `$2` + `"`)
   .replace(/(href|src|poster|data|action|srcset)='\/\/(.*?)'/gi, `$1` + `='http://` + `$2` + `'`)
   .replace(/(href|src|poster|data|action|srcset)="\/(.*?)"/gi, `$1` + `="${config.prefix}${proxy.url.encoded_origin}/` + `$2` + `"`)
   .replace(/(href|src|poster|data|action|srcset)='\/(.*?)'/gi, `$1` + `='${config.prefix}${proxy.url.encoded_origin}/` + `$2` + `'`)
   .replace(/'(https:\/\/|http:\/\/)(.*?)'/gi, function(str) {
      str = str.split(`'`).slice(1).slice(0, -1).join(``);
      return `'${config.prefix}${rewrite_url(str)}'`
    })
   .replace(/"(https:\/\/|http:\/\/)(.*?)"/gi, function(str) {
      str = str.split(`"`).slice(1).slice(0, -1).join(``);
      return `"${config.prefix}${rewrite_url(str)}"`
    })
   .replace(/(window|document).location.href/gi, `"${proxy.url.href}"`)
   .replace(/(window|document).location.hostname/gi, `"${proxy.url.hostname}"`)
   .replace(/(window|document).location.pathname/gi, `"${proxy.url.path}"`)
   .replace(/location.href/gi, `"${proxy.url.href}"`)
   .replace(/location.hostname/gi, `"${proxy.url.hostname}"`)
   .replace(/location.pathname/gi, `"${proxy.url.path}"`)
   .replace(/<html(.*?)>/gi, `<html` + '$1' + `><script src="${config.prefix}utils/assets/inject.js" id="_alloy_data" prefix="${config.prefix}" url="${btoa(proxy.url.href)}"></script>`);

   // Temp hotfix for Youtube search bar until my script injection can fix it.

   if (proxy.url.hostname == 'www.youtube.com') { proxy.sendResponse = proxy.sendResponse.replace(/\/results/gi, `${config.prefix}${proxy.url.encoded_origin}/results`);};
} else if (proxy.content_type.startsWith('text/css')) {
    proxy.sendResponse = proxy.sendResponse.toString()      
   .replace(/url\("\/\/(.*?)"\)/gi, `url("http://` + `$1` + `")`)
   .replace(/url\('\/\/(.*?)'\)/gi, `url('http://` + `$1` + `')`)
   .replace(/url\(\/\/(.*?)\)/gi, `url(http://` + `$1` + `)`)
   .replace(/url\("\/(.*?)"\)/gi, `url("${config.prefix}${proxy.url.encoded_origin}/` + `$1` + `")`)
   .replace(/url\('\/(.*?)'\)/gi, `url('${config.prefix}${proxy.url.encoded_origin}/` + `$1` + `')`)
   .replace(/url\(\/(.*?)\)/gi, `url(${config.prefix}${proxy.url.encoded_origin}/` + `$1` + `)`)
   .replace(/"(https:\/\/|http:\/\/)(.*?)"/gi, function(str) {
    str = str.split(`"`).slice(1).slice(0, -1).join(``);
    return `"${config.prefix}${rewrite_url(str)}"`
    })
   .replace(/'(https:\/\/|http:\/\/)(.*?)'/gi, function(str) {
    str = str.split(`'`).slice(1).slice(0, -1).join(``);
    return `'${config.prefix}${rewrite_url(str)}'`
    })
   .replace(/\((https:\/\/|http:\/\/)(.*?)\)/gi, function(str) {
    str = str.split(`(`).slice(1).join(``).split(')').slice(0, -1).join('');
    return `(${config.prefix}${rewrite_url(str)})`
    });

};
// We send the response from the server rewritten.
res.send(proxy.sendResponse);
});

// Store users in JSON file
const usersFile = './data/users.json';
let users = {};

// Load users from file
try {
  if (fs.existsSync(usersFile)) {
    users = JSON.parse(fs.readFileSync(usersFile, 'utf8')).users;
  }
} catch (err) {
  console.error('Error loading users:', err);
}

// Save users to file
const saveUsers = () => {
  try {
    fs.writeFileSync(usersFile, JSON.stringify({ users }, null, 2));
  } catch (err) {
    console.error('Error saving users:', err);
  }
};

// Generate a random salt
const generateSalt = () => {
  return require('crypto').randomBytes(16).toString('hex');
};

// Hash password with salt
const hashPassword = (password, salt) => {
  return require('crypto')
    .createHash('sha256')
    .update(password + salt)
    .digest('hex');
};

const ADMIN_PASSWORD = 'your-secret-password';

app.get('/signup', (req, res) => {
  res.sendFile(__dirname + '/public/signup.html');
});

app.post('/signup', (req, res) => {
  const formData = new URLSearchParams(req.raw_body);
  const username = formData.get('username');
  const password = formData.get('password');
  const confirmPassword = formData.get('confirm_password');

  if (!username || !password || !confirmPassword) {
    return res.redirect('/signup?error=All fields are required');
  }

  if (username.length < 3) {
    return res.redirect('/signup?error=Username must be at least 3 characters');
  }

  if (password.length < 8) {
    return res.redirect('/signup?error=Password must be at least 8 characters');
  }

  if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.redirect('/signup?error=Password must contain at least one uppercase letter and one number');
  }

  if (password !== confirmPassword) {
    return res.redirect('/signup?error=Passwords do not match');
  }

  if (users[username]) {
    return res.redirect('/signup?error=Username already exists');
  }

  // Generate salt and hash password
  const salt = generateSalt();
  const hashedPassword = hashPassword(password, salt);
  
  // Store user with salt and hashed password
  users[username] = {
    password: hashedPassword,
    salt: salt
  };
  saveUsers();
  res.redirect('/login');
});

// Auth middleware
const requireAuth = (req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/login');
  }
};

app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

app.post('/login', (req, res) => {
  const formData = new URLSearchParams(req.raw_body);
  const username = formData.get('username');
  const password = formData.get('password');

  if (!username || !password) {
    return res.redirect('/login?error=Please enter both username and password');
  }

  const user = users[username];
  if (!user) {
    return res.redirect('/login?error=Invalid username or password');
  }

  // Hash password with stored salt for comparison
  const hashedPassword = hashPassword(password, user.salt);
  
  if (user.password === hashedPassword) {
    req.session.authenticated = true;
    req.session.username = username;
    res.redirect('/secret');
  } else {
    res.redirect('/login?error=Invalid username or password');
  }
});

app.get('/logout', (req, res) => {
  // Clear session
  req.session.authenticated = false;
  req.session.username = null;
  
  // Clear cookies
  res.clearCookie('username');
  
  res.redirect('/login');
});

app.get('/secret', requireAuth, (req, res) => {
  res.sendFile(__dirname + '/public/secret.html');
});

app.get('/games', requireAuth, (req, res) => {
  res.sendFile(__dirname + '/public/games.html');
});

app.get('/profile', requireAuth, (req, res) => {
  res.sendFile(__dirname + '/public/profile.html');
});

app.get('/contributors', requireAuth, (req, res) => {
  res.sendFile(__dirname + '/public/contributors.html');
});

app.post('/change-password', requireAuth, (req, res) => {
  const formData = new URLSearchParams(req.raw_body);
  const currentPassword = formData.get('current_password');
  const newPassword = formData.get('new_password');
  const confirmPassword = formData.get('confirm_password');
  
  const user = users[req.session.username];
  const currentHashedPassword = hashPassword(currentPassword, user.salt);
  
  if (user.password !== currentHashedPassword) {
    return res.redirect('/profile?error=Current password is incorrect');
  }
  
  if (newPassword !== confirmPassword) {
    return res.redirect('/profile?error=New passwords do not match');
  }
  
  if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.redirect('/profile?error=Password must be at least 8 characters with one uppercase letter and one number');
  }
  
  // Generate new salt and hash new password
  const newSalt = generateSalt();
  const newHashedPassword = hashPassword(newPassword, newSalt);
  
  // Update user with new salt and hashed password
  users[req.session.username] = {
    password: newHashedPassword,
    salt: newSalt
  };
  saveUsers();
  res.redirect('/profile?success=Password changed successfully');
});

// Admin middleware
const requireAdmin = (req, res, next) => {
  if (req.session.username === 'admin') {
    next();
  } else {
    res.redirect('/login');
  }
};

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

app.get('/admin/users', requireAdmin, (req, res) => {
  res.json(Object.keys(users));
});

app.post('/admin/delete-user', requireAdmin, (req, res) => {
  const formData = new URLSearchParams(req.raw_body);
  const username = formData.get('username');
  if (username && username !== 'admin') {
    delete users[username];
    saveUsers();
    res.redirect('/admin');
  } else {
    res.redirect('/admin?error=Cannot delete admin user');
  }
});

app.use('/', express.static('public'));

app.use(async(req, res, next) => {
   if (req.headers['referer']) {

    let referer =  '/' + String(req.headers['referer']).split('/').splice(3).join('/');

    referer = rewrite_url(referer.replace(config.prefix, ''), 'decode').split('/').splice(0, 3).join('/');

    if (referer.startsWith('https://') || referer.startsWith('http://')) {
      res.redirect(307, config.prefix + btoa(referer) + req.url)
    } else {
       if (req.session.url) {

         res.redirect(307, config.prefix + btoa(req.session.url) + req.url)

       } else return next();
    }
   } else if (req.session.url) {

    res.redirect(307, config.prefix + btoa(req.session.url) + req.url)

  } else return next();
  });