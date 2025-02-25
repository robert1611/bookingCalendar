const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const fs = require('fs');

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
let oAuth2Client = null;

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'bobby@dupreegaragedoors.com',
    pass: 'cuoyhyiruyryowwz'
  }
});

// Simplify OAuth setup
function setupOAuth() {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.log('No credentials.json found - calendar integration disabled');
      return null;
    }
    
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    if (!credentials.web || !credentials.web.client_id) {
      console.log('Invalid credentials format - calendar integration disabled');
      return null;
    }
    
    const { client_id, client_secret } = credentials.web;
    const redirectUri = 'http://localhost:5000/oauth2callback';
    
    const auth = new google.auth.OAuth2(client_id, client_secret, redirectUri);
    
    // Try to load saved token
    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
      auth.setCredentials(token);
      console.log('Loaded saved OAuth token');
      return auth;
    } else {
      console.log('No OAuth token found - visit /auth to set up calendar integration');
      return auth; // Return auth client without credentials
    }
  } catch (error) {
    console.error('Error setting up OAuth:', error);
    return null;
  }
}

// Initialize OAuth
oAuth2Client = setupOAuth();

// Auth routes
app.get('/auth', (req, res) => {
  if (!oAuth2Client) {
    return res.status(500).send('OAuth client not initialized');
  }
  
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  if (!oAuth2Client) {
    return res.status(500).send('OAuth client not initialized');
  }
  
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No authorization code provided');
  }
  
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('OAuth token saved');
    res.send('Authentication successful! Calendar integration is now active. You can close this window.');
  } catch (error) {
    console.error('Error retrieving access token:', error);
    res.status(500).send('Error retrieving access token');
  }
});

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
        time TEXT,
        calendar_event_id TEXT
    )
`);

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
        // Get database bookings
        const today = new Date();
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);
        
        const todayStr = today.toISOString();
        const nextWeekStr = nextWeek.toISOString();
        
        // Create a promise for database query
        const getDbEvents = new Promise((resolve, reject) => {
            db.all(
                'SELECT date, time FROM bookings WHERE date >= ? AND date <= ?',
                [todayStr, nextWeekStr],
                (err, rows) => {
                    if (err) {
                        console.error('Error fetching database bookings:', err);
                        resolve([]);
                        return;
                    }
                    
                    // Format database bookings
                    const dbEvents = rows.map(booking => {
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
                    
                    resolve(dbEvents);
                }
            );
        });
        
        // Get calendar events if OAuth is set up
        const getCalendarEvents = async () => {
            if (!oAuth2Client || !oAuth2Client.credentials) {
                return [];
            }
            
            try {
                const calendar = google.calendar({version: 'v3', auth: oAuth2Client});
                const response = await calendar.events.list({
                    calendarId: 'bobby@dupreegaragedoors.com',
                    timeMin: today.toISOString(),
                    timeMax: nextWeek.toISOString(),
                    singleEvents: true,
                    orderBy: 'startTime'
                });
                return response.data.items || [];
            } catch (error) {
                console.error('Error fetching calendar events:', error);
                return [];
            }
        };
        
        // Get events from both sources
        const [dbEvents, calendarEvents] = await Promise.all([
            getDbEvents,
            getCalendarEvents()
        ]);
        
        // Combine both sources of events
        const allEvents = [...dbEvents, ...calendarEvents];
        
        res.json({
            success: true,
            events: allEvents
        });
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
                if (oAuth2Client && oAuth2Client.credentials) {
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
                            to: 'bobby@dupreegaragedoors.com',
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

// Start server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    if (!oAuth2Client || !oAuth2Client.credentials) {
        console.log(`To enable calendar integration, visit: http://localhost:${PORT}/auth`);
    } else {
        console.log('Calendar integration is active');
    }
});