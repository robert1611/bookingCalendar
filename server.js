const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

const app = express();
const PORT = 5000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname)); 

// OAuth2 setup
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credentials.json';

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'bobby@dupreegaragedoors.com',
    pass: 'cuoyhyiruyryowwz' 
  }
});

let oAuth2Client = null;

// Command-line OAuth authorization
function getAccessToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this URL:', authUrl);
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) {
        console.error('Error retrieving access token', err);
        return callback(err);
      }
      oAuth2Client.setCredentials(token);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
      console.log('Token stored to', TOKEN_PATH);
      callback(null, oAuth2Client);
    });
  });
}

// Initialize OAuth client
function initializeOAuth(callback) {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.error('Error: credentials.json file not found');
      return callback(new Error('credentials.json file not found'));
    }
    
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    
    // Check if we have a token
    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
      oAuth2Client.setCredentials(token);
      console.log('OAuth client initialized with existing token');
      callback(null, oAuth2Client);
    } else {
      console.log('No token found - starting authorization');
      getAccessToken(oAuth2Client, callback);
    }
  } catch (error) {
    console.error('Error initializing OAuth:', error);
    callback(error);
  }
}

// Initialize SQLite database
const db = new sqlite3.Database('bookings.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to SQLite database.');
});

// Create table if it doesn't exist
db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT,
        last_name TEXT,
        phone TEXT,
        email TEXT,
        service TEXT,
        date TEXT,
        time TEXT
   )
`, function(err) {
    if (err) {
        console.error('Error creating table:', err.message);
        return;
    }
    
    // Check if calendar_event_id column exists, add it if it doesn't
    db.get("PRAGMA table_info(bookings)", (err, rows) => {
        if (err) {
            console.error('Error checking table schema:', err.message);
            return;
        }
        
        // If calendar_event_id column doesn't exist, add it
        db.run(`ALTER TABLE bookings ADD COLUMN calendar_event_id TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding calendar_event_id column:', err.message);
            } else {
                console.log('Database schema is up to date');
            }
        });
    });
});

// Add route to view all bookings
app.get('/bookings', (req, res) => {
  db.all('SELECT * FROM bookings', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ bookings: rows });
  });
});

// Get available time slots
app.get('/availability', async (req, res) => {
    try {
        // First get database bookings
        const today = new Date();
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);
        
        const todayStr = today.toISOString();
        const nextWeekStr = nextWeek.toISOString();
        
        // Get existing bookings from database
        db.all(
            'SELECT date, time FROM bookings WHERE date >= ? AND date <= ?',
            [todayStr, nextWeekStr],
            async (err, dbRows) => {
                if (err) {
                    console.error('Error fetching database bookings:', err);
                    return res.json({
                        success: true,
                        events: []
                    });
                }
                
                // Format database bookings
                const dbEvents = dbRows.map(booking => {
                    const [startTime] = booking.time.split(' - ');
                    const [hours, minutes] = startTime.split(':');
                    const isPM = startTime.includes('PM');
                    
                    const bookingDate = new Date(booking.date);
                    bookingDate.setHours(
                        isPM && hours !== '12' ? parseInt(hours) + 12 : parseInt(hours),
                        parseInt(minutes),
                        0,
                        0
                    );
                    
                    const endTime = new Date(bookingDate);
                    endTime.setHours(endTime.getHours() + 3);
                    
                    return {
                        start: {
                            dateTime: bookingDate.toISOString()
                        },
                        end: {
                            dateTime: endTime.toISOString()  
                        }
                    };
                });
                
                // Also get calendar events if OAuth is set up
                let calendarEvents = [];
                if (oAuth2Client) {
                    try {
                        const calendar = google.calendar({version: 'v3', auth: oAuth2Client});
                        const response = await calendar.events.list({
                            calendarId: 'robert1611@gmail.com',
                            timeMin: today.toISOString(),
                            timeMax: nextWeek.toISOString(),
                            singleEvents: true,
                            orderBy: 'startTime'
                        });
                        calendarEvents = response.data.items || [];
                    } catch (calendarError) {
                        console.error('Error fetching calendar events:', calendarError);
                    }
                }
                
                // Combine both sources of events
                const allEvents = [...dbEvents, ...calendarEvents];
                
                res.json({
                    success: true,
                    events: allEvents
                });
            }
        );
    } catch (error) {
        console.error('Error fetching availability:', error);
        res.json({
            success: true,
            events: []
        });
    }
});

// Handle booking submission
app.post('/submit_booking', async (req, res) => {
    const { firstName, lastName, phone, email, service, date, time } = req.body;

    if (!firstName || !lastName || !phone || !service || !date || !time) {
        return res.status(400).json({ error: 'All required fields must be filled.' });
    }

    try {
        // Check if this time slot is already booked
        const bookingDate = new Date(date);
        const bookingDateStr = bookingDate.toISOString().split('T')[0];
        
        db.get(
            'SELECT COUNT(*) as count FROM bookings WHERE date LIKE ? AND time = ?',
            [`${bookingDateStr}%`, time],
            async (err, result) => {
                if (err) {
                    console.error('Error checking booking availability:', err);
                    return res.status(500).json({ error: 'Failed to check availability.' });
                }
                
                // If a booking already exists for this time slot
                if (result.count > 0) {
                    return res.status(409).json({ 
                        error: 'This time slot is already booked. Please select another time.'
                    });
                }
                
                // Format event times
                const [startTime] = time.split(' - ');
                const eventDate = new Date(date);
                const [hours, minutes] = startTime.split(':');
                const isPM = startTime.includes('PM');
                
                eventDate.setHours(
                    isPM && hours !== '12' ? parseInt(hours) + 12 : parseInt(hours),
                    parseInt(minutes),
                    0,
                    0
                );

                const endDate = new Date(eventDate);
                endDate.setHours(endDate.getHours() + 3); // 3-hour window

                // Format for email
                const formattedDate = eventDate.toLocaleDateString('en-US', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });

                // Create calendar event if OAuth is set up
                let calendarEventId = null;
                if (oAuth2Client) {
                    try {
                        const calendar = google.calendar({version: 'v3', auth: oAuth2Client});
                        const event = {
                            summary: `Garage Door ${service} - ${firstName} ${lastName}`,
                            description: `Service: ${service}\nName: ${firstName} ${lastName}\nPhone: ${phone}${email ? '\nEmail: ' + email : ''}`,
                            start: {
                                dateTime: eventDate.toISOString(),
                                timeZone: 'America/Chicago'
                            },
                            end: {
                                dateTime: endDate.toISOString(),
                                timeZone: 'America/Chicago'
                            }
                        };
                        
                        const calendarResponse = await calendar.events.insert({
                            calendarId: 'robert1611@gmail.com',
                            resource: event
                        });
                        calendarEventId = calendarResponse.data.id;
                        console.log('Event created in calendar:', calendarEventId);
                    } catch (calendarError) {
                        console.error('Error creating calendar event:', calendarError);
                    }
                }

                // Save to database
                const stmt = db.prepare('INSERT INTO bookings (first_name, last_name, phone, email, service, date, time, calendar_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
                stmt.run(firstName, lastName, phone, email || '', service, date, time, calendarEventId, async function (err) {
                    if (err) {
                        console.error(err.message);
                        return res.status(500).json({ error: 'Failed to save booking.' });
                    }
                    
                    const bookingId = this.lastID;
                    
                    // Send email to you
                    try {
                        const adminMailOptions = {
                            from: 'bobby@dupreegaragedoors.com',
                            to: 'robert1611@gmail.com',
                            subject: `New Booking: ${service} - ${firstName} ${lastName}`,
                            html: `
                                <h2>New Garage Door Service Booking</h2>
                                <p><strong>Service:</strong> ${service}</p>
                                <p><strong>Date:</strong> ${formattedDate}</p>
                                <p><strong>Time:</strong> ${time}</p>
                                <p><strong>Name:</strong> ${firstName} ${lastName}</p>
                                <p><strong>Phone:</strong> ${phone}</p>
                                ${email ? `<p><strong>Email:</strong> ${email}</p>` : ''}
                                <p><strong>Booking ID:</strong> ${bookingId}</p>
                                ${calendarEventId ? '<p>Event has been added to your calendar.</p>' : '<p>Event could not be added to calendar.</p>'}
                            `
                        };
                        
                        await transporter.sendMail(adminMailOptions);
                        console.log('Admin email notification sent');
                        
                        // Send confirmation to customer if they provided email
                        if (email) {
                            const customerMailOptions = {
                                from: 'bobby@dupreegaragedoors.com',
                                to: email,
                                subject: `Your Garage Door Service Appointment Confirmation`,
                                html: `
                                    <h2>Appointment Confirmation</h2>
                                    <p>Thank you for scheduling with Dupree Garage Doors!</p>
                                    <p><strong>Service:</strong> ${service}</p>
                                    <p><strong>Date:</strong> ${formattedDate}</p>
                                    <p><strong>Time:</strong> ${time}</p>
                                    <p>If you need to reschedule, please call us at (555) 123-4567.</p>
                                    <p>Thank you for your business!</p>
                                `
                            };
                            
                            await transporter.sendMail(customerMailOptions);
                            console.log('Customer confirmation email sent');
                        }
                        
                        res.json({ 
                            message: 'Booking successfully saved', 
                            bookingId: bookingId,
                            calendarEventCreated: !!calendarEventId,
                            emailSent: true,
                            customerNotified: !!email
                        });
                    } catch (emailError) {
                        console.error('Error sending email:', emailError);
                        res.json({ 
                            message: 'Booking saved but email notification failed', 
                            bookingId: bookingId,
                            calendarEventCreated: !!calendarEventId,
                            emailSent: false
                        });
                    }
                });
                stmt.finalize();
            }
        );
    } catch (error) {
        console.error('Error processing booking:', error);
        res.status(500).json({ error: 'Failed to process booking request.' });
    }
});

// Serve homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'extra.html'));
});

// Initialize OAuth and start server
initializeOAuth((err, client) => {
    if (err) {
        console.error('OAuth initialization failed:', err);
    }
    
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
});