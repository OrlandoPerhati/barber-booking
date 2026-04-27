const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT || 3000);
const BARBERS = ['deni', 'cerri'];
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 21;
const SLOT_MINUTES = [0, 30];
const BOOKING_WINDOW_DAYS = 7;
const ADMIN_COOKIE = 'barber_admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const COOKIE_SECRET = process.env.COOKIE_SECRET;
const mongoURI = process.env.MONGODB_URI;

app.set('trust proxy', 1);

if (!mongoURI) {
  throw new Error('Missing MONGODB_URI in environment');
}

if (!ADMIN_PASSWORD || !COOKIE_SECRET) {
  throw new Error('Missing ADMIN_PASSWORD or COOKIE_SECRET in environment');
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

mongoose.connect(mongoURI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

const appointmentSchema = new mongoose.Schema({
  barber: String,
  start: Date,
  end: Date,
  customer: String
});

appointmentSchema.index({ barber: 1, start: 1 }, { unique: true });

const Appointment = mongoose.model('Appointment', appointmentSchema);
const eventClients = new Set();

function sendCalendarEvent(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastCalendarChange(reason) {
  const payload = {
    reason,
    at: new Date().toISOString()
  };

  for (const client of eventClients) {
    if (client.writableEnded) {
      eventClients.delete(client);
      continue;
    }

    try {
      sendCalendarEvent(client, 'appointments-changed', payload);
    } catch (err) {
      eventClients.delete(client);
    }
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map(cookie => cookie.trim())
      .filter(Boolean)
      .map(cookie => {
        const [name, ...value] = cookie.split('=');
        return [name, decodeURIComponent(value.join('='))];
      })
  );
}

function sign(value) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('hex');
}

function createAdminToken() {
  const payload = `admin:${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

function isValidAdminToken(token) {
  if (!token) return false;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = sign(payload);
  if (signature.length !== expected.length) return false;

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function isAdmin(req) {
  return isValidAdminToken(parseCookies(req)[ADMIN_COOKIE]);
}

function requireAdminApi(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({ success: false, message: 'Admin login required' });
  }

  next();
}

function requireAdminPage(req, res, next) {
  if (!isAdmin(req)) {
    return res.redirect('/login.html');
  }

  next();
}

function validateBarber(barber) {
  return BARBERS.includes(barber);
}

function parseStartDate(start) {
  const startDate = new Date(start);
  return Number.isNaN(startDate.getTime()) ? null : startDate;
}

function validateSlot(barber, startDate) {
  if (!validateBarber(barber)) {
    return 'Unknown barber.';
  }

  if (!startDate) {
    return 'Invalid appointment time.';
  }

  const now = new Date();
  const { rangeStart, rangeEnd } = buildRange();
  const hour = startDate.getHours();
  const minute = startDate.getMinutes();

  if (startDate < now) {
    return 'Cannot book an appointment in the past.';
  }

  if (startDate < rangeStart || startDate >= rangeEnd) {
    return 'You can only book up to 1 week in advance.';
  }

  if (hour < BUSINESS_START_HOUR || hour >= BUSINESS_END_HOUR || !SLOT_MINUTES.includes(minute)) {
    return 'Appointment must be during business hours on a 30-minute slot.';
  }

  if (startDate.getSeconds() !== 0 || startDate.getMilliseconds() !== 0) {
    return 'Appointment time must be an exact slot.';
  }

  return null;
}

function toPublicAppointment(appointment) {
  return {
    _id: appointment._id,
    barber: appointment.barber,
    start: appointment.start,
    end: appointment.end,
    reserved: Boolean(appointment.customer)
  };
}

function startOfDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function buildRange() {
  const rangeStart = startOfDay(new Date());
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setDate(rangeEnd.getDate() + BOOKING_WINDOW_DAYS);
  return { rangeStart, rangeEnd };
}

async function ensureFutureAppointments() {
  const { rangeStart } = buildRange();
  const operations = [];

  for (let dayOffset = 0; dayOffset < BOOKING_WINDOW_DAYS; dayOffset++) {
    for (let hour = BUSINESS_START_HOUR; hour < BUSINESS_END_HOUR; hour++) {
      for (const minute of SLOT_MINUTES) {
        const start = new Date(rangeStart);
        start.setDate(rangeStart.getDate() + dayOffset);
        start.setHours(hour, minute, 0, 0);

        const end = new Date(start);
        end.setMinutes(start.getMinutes() + 30);

        for (const barber of BARBERS) {
          operations.push({
            updateOne: {
              filter: { barber, start },
              update: {
                $setOnInsert: {
                  barber,
                  start,
                  end,
                  customer: null
                }
              },
              upsert: true
            }
          });
        }
      }
    }
  }

  if (operations.length > 0) {
    await Appointment.bulkWrite(operations, { ordered: false });
  }
}

app.get('/appointments/:barber', async (req, res) => {
  const barber = req.params.barber;

  if (!validateBarber(barber)) {
    return res.status(404).json({ success: false, message: 'Unknown barber' });
  }

  try {
    await ensureFutureAppointments();
    const { rangeStart, rangeEnd } = buildRange();

    const appointments = await Appointment.find({
      barber,
      start: { $gte: rangeStart, $lt: rangeEnd }
    }).sort({ start: 1 });

    res.json(appointments.map(toPublicAppointment));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  eventClients.add(res);
  sendCalendarEvent(res, 'connected', { at: new Date().toISOString() });

  const keepAlive = setInterval(() => {
    sendCalendarEvent(res, 'heartbeat', { at: new Date().toISOString() });
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    eventClients.delete(res);
  });
});

app.get('/api/admin/appointments/:barber', requireAdminApi, async (req, res) => {
  const barber = req.params.barber;

  if (!validateBarber(barber)) {
    return res.status(404).json({ success: false, message: 'Unknown barber' });
  }

  try {
    await ensureFutureAppointments();
    const { rangeStart, rangeEnd } = buildRange();

    const appointments = await Appointment.find({
      barber,
      start: { $gte: rangeStart, $lt: rangeEnd }
    }).sort({ start: 1 });

    res.json(appointments);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Incorrect password' });
  }

  const secure = process.env.NODE_ENV === 'production' || req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(createAdminToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`
  );
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ success: true });
});

app.post('/api/book', async (req, res) => {
  const { barber, start, customer } = req.body;

  if (!barber || !start || !customer) {
    return res.status(400).json({ success: false, message: 'barber, start, and customer are required' });
  }

  const startDate = parseStartDate(start);
  const slotError = validateSlot(barber, startDate);

  if (slotError) {
    return res.status(400).json({ success: false, message: slotError });
  }

  try {
    await ensureFutureAppointments();

    const appointment = await Appointment.findOneAndUpdate(
      { barber, start: startDate, customer: null },
      { customer },
      { new: true }
    );

    if (appointment) {
      broadcastCalendarChange('booked');
      res.json({ success: true, message: 'Appointment booked!', appointment });
    } else {
      res.status(400).json({ success: false, message: 'Slot is not available or already booked.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/appointments', requireAdminApi, async (req, res) => {
  const { barber, start, end } = req.body;

  if (!barber || !start || !end) {
    return res.status(400).json({ success: false, message: 'barber, start, and end are required' });
  }

  const startDate = parseStartDate(start);
  const endDate = parseStartDate(end);
  const slotError = validateSlot(barber, startDate);

  if (slotError || !endDate) {
    return res.status(400).json({ success: false, message: slotError || 'Invalid appointment end time.' });
  }

  try {
    const exists = await Appointment.findOne({ barber, start: startDate });
    if (exists) {
      return res.status(400).json({ success: false, message: 'Appointment slot already exists' });
    }

    const newAppointment = new Appointment({
      barber,
      start: startDate,
      end: endDate,
      customer: null
    });

    await newAppointment.save();
    broadcastCalendarChange('slot-created');

    res.status(201).json({ success: true, message: 'Appointment slot created', appointment: newAppointment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.delete('/api/cancel/:id', requireAdminApi, async (req, res) => {
  const id = req.params.id;

  try {
    const result = await Appointment.findByIdAndUpdate(id, { customer: null });
    if (result) {
      broadcastCalendarChange('cancelled');
      res.json({ success: true, message: 'Booking cancelled.' });
    } else {
      res.status(404).json({ success: false, message: 'Appointment not found.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/appointments', requireAdminApi, async (req, res) => {
  try {
    await ensureFutureAppointments();
    const { rangeStart, rangeEnd } = buildRange();

    const appointments = await Appointment.find({
      start: { $gte: rangeStart, $lt: rangeEnd }
    }).sort({ barber: 1, start: 1 });

    res.json(appointments);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch appointments' });
  }
});

app.get('/admin.html', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, async () => {
  try {
    await ensureFutureAppointments();
  } catch (err) {
    console.error('Failed to prepare appointment slots:', err);
  }

  console.log(`Server running on http://localhost:${port}`);
});
