const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = 5000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'bobby@dupreegaragedoors.com',
    pass: 'cuoyhyiruyryowwz'
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
        time TEXT
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

// Get available time slots from database
app.get('/availability', (req, res) => {
    try {
        // Get all bookings for the next 7 days
        const today = new Date();
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);
        
        const todayStr = today.toISOString();
        const nextWeekStr = nextWeek.toISOString();
        
        db.all(
            'SELECT date, time FROM bookings WHERE date >= ? AND date <= ?',
            [todayStr, nextWeekStr],
            (err, rows) => {
                if (err) {
                    console.error('Error fetching bookings:', err);
                    return res.json({
                        success: true,
                        events: []
                    });
                }
                
                // Format database bookings to mimic calendar events
                const events = rows.map(booking => {
                    // Parse the booking time range (e.g., "7:00 AM - 10:00 AM")
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
                    
                    // Calculate end time (3 hours after start)
                    const endTime = new Date(bookingDate);
                    endTime.setHours(endTime.getHours() + 3);
                    
                    // Return in Google Calendar-like format
                    return {
                        start: {
                            dateTime: bookingDate.toISOString()
                        },
                        end: {
                            dateTime: endTime.toISOString()  
                        }
                    };
                });
                
                res.json({
                    success: true,
                    events: events
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
                
                // Format for email
                const formattedDate = bookingDate.toLocaleDateString('en-US', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });

                // Save to database
                const stmt = db.prepare('INSERT INTO bookings (first_name, last_name, phone, email, service, date, time) VALUES (?, ?, ?, ?, ?, ?, ?)');
                stmt.run(firstName, lastName, phone, email || '', service, date, time, async function (err) {
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
                            emailSent: true,
                            customerNotified: !!email
                        });
                    } catch (emailError) {
                        console.error('Error sending email:', emailError);
                        res.json({ 
                            message: 'Booking saved but email notification failed', 
                            bookingId: bookingId,
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
});