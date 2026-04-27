const mongoose = require('mongoose');
require('dotenv').config();

const mongoURI = process.env.MONGODB_URI;
const BARBERS = ['deni', 'cerri'];
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 21;
const SLOT_MINUTES = [0, 30];
const BOOKING_WINDOW_DAYS = 7;

if (!mongoURI) {
  throw new Error('Missing MONGODB_URI in environment');
}

const appointmentSchema = new mongoose.Schema({
  barber: String,
  start: Date,
  end: Date,
  customer: String
});

appointmentSchema.index({ barber: 1, start: 1 }, { unique: true });

const Appointment = mongoose.model('Appointment', appointmentSchema);

function startOfDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

async function generateAppointments() {
  await mongoose.connect(mongoURI);
  console.log('Connected to MongoDB');

  const today = startOfDay(new Date());
  const operations = [];

  for (let dayOffset = 0; dayOffset < BOOKING_WINDOW_DAYS; dayOffset++) {
    for (let hour = BUSINESS_START_HOUR; hour < BUSINESS_END_HOUR; hour++) {
      for (const minute of SLOT_MINUTES) {
        const start = new Date(today);
        start.setDate(today.getDate() + dayOffset);
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

  console.log('Sample appointments generated for deni and cerri.');
  await mongoose.disconnect();
}

generateAppointments().catch(async err => {
  console.error('Error generating appointments:', err);
  await mongoose.disconnect();
});
