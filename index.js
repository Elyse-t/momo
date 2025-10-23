import express from 'express';
import axios from 'axios';
import cors from 'cors';
import bodyParser from 'body-parser';
import { baseUrl, secondaryKey } from './config.js';
import { v4 as uuidv4 } from 'uuid';
import mysql from 'mysql2/promise';

const app = express();
const PORT = 3000;

// Database connection setup
const dbConfig = {
    host: 'bpoejafa5q9xhrvibkx6-mysql.services.clever-cloud.com',
    user: 'uzcnxswewezhsisp',
    password: 'kyZ8YkOVHtMQUv4Lf5hi',
    database: 'bpoejafa5q9xhrvibkx6'
};

// Create database connection pool
const pool = mysql.createPool(dbConfig);

// Middleware setup
app.use(cors({
    origin: ['http://localhost', 'http://localhost:80', 'http://localhost/swifftpass'],
    credentials: true
}));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Add request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    console.log('Body:', req.body);
    next();
});

// Cache for tokens & API user/key to avoid recreating every request
let apiUserId = null;
let apiKey = null;
let accessToken = null;
let accessTokenExpiry = 0;

// ===== NEW FUNCTION: UPDATE AVAILABLE SEATS =====
async function updateAvailableSeats(connection, trip_id, seats_booked) {
    try {
        console.log('🔄 Updating available seats for trip:', trip_id, 'Seats booked:', seats_booked);
        
        // First get current available seats
        const [currentSeats] = await connection.execute(
            'SELECT available_seats FROM trips WHERE trip_id = ?',
            [trip_id]
        );

        if (currentSeats.length === 0) {
            throw new Error('Trip not found');
        }

        const current_available = currentSeats[0].available_seats;
        const new_available = current_available - seats_booked;

        // Ensure we don't go below 0
        if (new_available < 0) {
            throw new Error('Not enough available seats');
        }

        // Update the available seats
        const [updateResult] = await connection.execute(
            'UPDATE trips SET available_seats = ? WHERE trip_id = ?',
            [new_available, trip_id]
        );

        console.log('✅ Seats updated successfully:', {
            trip_id: trip_id,
            old_seats: current_available,
            new_seats: new_available,
            seats_booked: seats_booked
        });

        return {
            success: true,
            old_seats: current_available,
            new_seats: new_available
        };
    } catch (error) {
        console.error('❌ Error updating available seats:', error.message);
        throw error;
    }
}

// ===== NEW FUNCTION: SCAN TICKET =====
async function scanTicket(ticket_id) {
    let connection;
    try {
        connection = await pool.getConnection();
        
        console.log('🔄 Scanning ticket:', ticket_id);
        
        // Start transaction
        await connection.beginTransaction();
        
        // First check if ticket exists and get current status
        const [ticketCheck] = await connection.execute(
            'SELECT ticket_id, checked, checked_at FROM tickets WHERE ticket_id = ?',
            [ticket_id]
        );

        if (ticketCheck.length === 0) {
            throw new Error('Ticket not found');
        }

        const ticket = ticketCheck[0];
        
        // Check if ticket is already scanned
        if (ticket.checked === 'yes') {
            return {
                success: false,
                message: 'Ticket already scanned',
                scanned_at: ticket.checked_at,
                status: 'already_used'
            };
        }

        // Update ticket to scanned status
        const [updateResult] = await connection.execute(
            'UPDATE tickets SET checked = "yes", checked_at = NOW() WHERE ticket_id = ?',
            [ticket_id]
        );

        if (updateResult.affectedRows === 0) {
            throw new Error('Failed to update ticket status');
        }

        // Log the scan event
        const [logResult] = await connection.execute(
            'INSERT INTO ticket_scans (ticket_id, scanned_at, scanner_info) VALUES (?, NOW(), ?)',
            [ticket_id, 'Express Scanner API']
        );

        // Commit transaction
        await connection.commit();
        
        // Get updated ticket info
        const [updatedTicket] = await connection.execute(
            'SELECT t.*, b.booking_id, c.firstname, c.lastname FROM tickets t LEFT JOIN bookings b ON t.booking_id = b.booking_id LEFT JOIN customers c ON b.customer_id = c.customer_id WHERE t.ticket_id = ?',
            [ticket_id]
        );

        console.log('✅ Ticket scanned successfully:', ticket_id);
        
        return {
            success: true,
            message: 'Ticket scanned successfully',
            ticket: updatedTicket[0],
            scan_id: logResult.insertId,
            status: 'scanned'
        };
        
    } catch (error) {
        // Rollback transaction in case of error
        if (connection) {
            await connection.rollback();
        }
        console.error('❌ Error scanning ticket:', error.message);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

// ===== NEW FUNCTION: GET TICKET STATUS =====
async function getTicketStatus(ticket_id) {
    let connection;
    try {
        connection = await pool.getConnection();
        
        const [tickets] = await connection.execute(
            `SELECT t.*, b.booking_id, c.firstname, c.lastname, c.contact, c.email,
                    trip.departure_datetime, trip.estimated_arrival,
                    bus.model as bus_model, bus.plates_number,
                    r.departure, r.destination
             FROM tickets t 
             LEFT JOIN bookings b ON t.booking_id = b.booking_id 
             LEFT JOIN customers c ON b.customer_id = c.customer_id 
             LEFT JOIN trips trip ON b.trip_id = trip.trip_id
             LEFT JOIN buses bus ON trip.bus_id = bus.bus_id
             LEFT JOIN routes r ON trip.route_id = r.route_id
             WHERE t.ticket_id = ?`,
            [ticket_id]
        );

        if (tickets.length === 0) {
            return {
                success: false,
                message: 'Ticket not found'
            };
        }

        return {
            success: true,
            ticket: tickets[0]
        };
        
    } catch (error) {
        console.error('❌ Error getting ticket status:', error.message);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

// Create API User & API Key (run once on server start)
async function setupApiUserAndKey() {
  if (apiUserId && apiKey) return;

  try {
    const referenceId = uuidv4();

    // Create API User
    const apiUserResponse = await axios.post(
      `${baseUrl}/v1_0/apiuser`,
      { providerCallbackHost: 'http://localhost:3000/callback' },
      {
        headers: {
          'X-Reference-Id': referenceId,
          'Ocp-Apim-Subscription-Key': secondaryKey,
          'Content-Type': 'application/json',
        },
      }
    );

    if (apiUserResponse.status !== 201) {
      throw new Error('Failed to create API user');
    }
    apiUserId = referenceId;

    // Create API Key
    const apiKeyResponse = await axios.post(
      `${baseUrl}/v1_0/apiuser/${apiUserId}/apikey`,
      {},
      {
        headers: {
          'Ocp-Apim-Subscription-Key': secondaryKey,
        },
      }
    );

    if (apiKeyResponse.status !== 201) {
      throw new Error('Failed to create API key');
    }
    apiKey = apiKeyResponse.data.apiKey;
    console.log('API User & Key created:', apiUserId, apiKey);
  } catch (error) {
    console.error('Error during API user/key setup:', error.message);
    throw error;
  }
}

// Get access token, cache it with expiry
async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry) {
    return accessToken; // return cached token if still valid
  }

  try {
    const tokenResponse = await axios.post(
      `${baseUrl}/collection/token/`,
      {},
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${apiUserId}:${apiKey}`).toString('base64'),
          'Ocp-Apim-Subscription-Key': secondaryKey,
        },
      }
    );

    if (tokenResponse.status === 200) {
      accessToken = tokenResponse.data.access_token;
      // Expires in seconds, convert to ms and subtract 60s buffer
      accessTokenExpiry = Date.now() + (tokenResponse.data.expires_in - 60) * 1000;
      return accessToken;
    } else {
      throw new Error('Failed to retrieve access token');
    }
  } catch (error) {
    console.error('Error getting access token:', error.message);
    throw error;
  }
}

// Function to create customer, booking, payment, and ticket ONLY on successful payment
async function createCompleteBooking(bookingData, paymentResult) {
    let connection;
    try {
        connection = await pool.getConnection();
        
        console.log('Creating complete booking with data:', bookingData);
        console.log('Payment result:', paymentResult);
        
        // Start transaction
        await connection.beginTransaction();
        
        // ===== ADDED: SUBTRACT AVAILABLE SEATS =====
        console.log('🔄 Starting seat subtraction...');
        const seatUpdateResult = await updateAvailableSeats(
            connection, 
            bookingData.trip_id, 
            bookingData.number_of_seats
        );
        console.log('✅ Seat subtraction completed:', seatUpdateResult);
        
        // 1. First insert into customers table
        const [customerResult] = await connection.execute(
            `INSERT INTO customers (firstname, lastname, contact, email, created_at) 
             VALUES (?, ?, ?, ?, NOW())`,
            [
                bookingData.firstname,
                bookingData.lastname, 
                bookingData.phoneNumber,
                bookingData.email
            ]
        );

        const customerId = customerResult.insertId;
        console.log('Customer created successfully with ID:', customerId);
        
        // 2. Then insert into bookings table using the customer_id
        const [bookingResult] = await connection.execute(
            `INSERT INTO bookings (customer_id, trip_id, number_of_seats, booking_date) 
             VALUES (?, ?, ?, NOW())`,
            [customerId, bookingData.trip_id, bookingData.number_of_seats]
        );

        const bookingId = bookingResult.insertId;
        console.log('Booking created successfully with ID:', bookingId);
        
        // 3. Insert into payments table
        const [paymentInsertResult] = await connection.execute(
            `INSERT INTO payments (booking_id, amount, payment_method, transaction_id, payment_status, time_paid, created_at) 
             VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                bookingId,
                bookingData.amount,
                bookingData.payment_method || 'momo',
                paymentResult.financialTransactionId || paymentResult.referenceId,
                'completed',
            ]
        );

        const paymentId = paymentInsertResult.insertId;
        console.log('Payment recorded successfully with ID:', paymentId);
        
        // 4. Insert into tickets table
        const [ticketResult] = await connection.execute(
            `INSERT INTO tickets (booking_id, checked, created_at) 
             VALUES (?, 'no', NOW())`,
            [bookingId]
        );

        const ticketId = ticketResult.insertId;
        console.log('Ticket created successfully with ID:', ticketId);
        
        // Commit transaction
        await connection.commit();
        
        return {
            customer_id: customerId,
            booking_id: bookingId,
            payment_id: paymentId,
            ticket_id: ticketId,
            seat_update: seatUpdateResult, // Added seat update info
            success: true
        };
        
    } catch (error) {
        // Rollback transaction in case of error
        if (connection) {
            await connection.rollback();
        }
        console.error('Error creating complete booking:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

// ===== ROUTES =====

// ===== NEW ROUTE: SCAN TICKET =====
app.post('/ticket/scan', async (req, res) => {
    const { ticket_id } = req.body;
    
    console.log('📱 Received ticket scan request for:', ticket_id);
    
    if (!ticket_id) {
        return res.status(400).json({
            success: false,
            message: 'Ticket ID is required',
            code: 'MISSING_TICKET_ID'
        });
    }

    try {
        const result = await scanTicket(ticket_id);
        
        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(409).json(result); // 409 Conflict for already scanned tickets
        }
        
    } catch (error) {
        console.error('❌ Error in ticket scan route:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to scan ticket',
            code: 'SCAN_ERROR',
            details: error.message
        });
    }
});

// ===== NEW ROUTE: GET TICKET STATUS =====
app.get('/ticket/:ticket_id', async (req, res) => {
    const { ticket_id } = req.params;
    
    console.log('📋 Received ticket status request for:', ticket_id);
    
    try {
        const result = await getTicketStatus(ticket_id);
        
        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(404).json(result);
        }
        
    } catch (error) {
        console.error('❌ Error in ticket status route:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to get ticket status',
            code: 'STATUS_ERROR',
            details: error.message
        });
    }
});

// ===== NEW ROUTE: VERIFY TICKET (For QR Code Scanning) =====
app.get('/ticket/verify/:ticket_id', async (req, res) => {
    const { ticket_id } = req.params;
    
    console.log('🔍 Received ticket verification request for:', ticket_id);
    
    try {
        const result = await getTicketStatus(ticket_id);
        
        if (result.success) {
            res.status(200).json({
                success: true,
                valid: true,
                ticket: result.ticket,
                status: result.ticket.checked === 'yes' ? 'used' : 'active',
                message: result.ticket.checked === 'yes' ? 'Ticket already used' : 'Ticket is valid'
            });
        } else {
            res.status(404).json({
                success: false,
                valid: false,
                message: 'Ticket not found'
            });
        }
        
    } catch (error) {
        console.error('❌ Error in ticket verification route:', error.message);
        res.status(500).json({
            success: false,
            valid: false,
            message: 'Verification failed',
            code: 'VERIFICATION_ERROR'
        });
    }
});

// Process payment request - NO BOOKING CREATION HERE
app.post('/process_payment', async (req, res) => {
  console.log('Processing payment request:', req.body);
  
  const { 
    phoneNumber, 
    amount, 
    payment_method, 
    user_id, 
    trip_id, 
    number_of_seats,
    firstname,
    lastname,
    email
  } = req.body;
  
  // Validate required fields
  const requiredFields = {
    phoneNumber, amount, user_id, trip_id, number_of_seats,
    firstname, lastname, email
  };
  
  const missingFields = Object.entries(requiredFields)
    .filter(([key, value]) => !value)
    .map(([key]) => key);
    
  if (missingFields.length > 0) {
    return res.status(400).json({ 
      success: false,
      message: `Missing required fields: ${missingFields.join(', ')}`,
      code: 'MISSING_FIELDS',
      missingFields
    });
  }

  // Validate phone number format
  const cleanedPhone = phoneNumber.toString().replace(/\s/g, '');
  const phoneRegex = /^(078|079|072|073)\d{7}$/;
  
  if (!phoneRegex.test(cleanedPhone)) {
    return res.status(400).json({
      success: false,
      message: 'Please enter a valid Rwandan phone number (078, 079, 072, or 073)',
      code: 'INVALID_PHONE'
    });
  }

  // Validate amount
  const paymentAmount = parseFloat(amount);
  if (isNaN(paymentAmount) || paymentAmount <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Please enter a valid amount',
      code: 'INVALID_AMOUNT'
    });
  }

  // Validate number of seats
  const seats = parseInt(number_of_seats);
  if (isNaN(seats) || seats <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Please enter a valid number of seats',
      code: 'INVALID_SEATS'
    });
  }

  try {
    await setupApiUserAndKey();
    const token = await getAccessToken();
    const referenceId = uuidv4();
    const externalId = uuidv4();

    const requestBody = {
      amount: paymentAmount.toString(),
      currency: 'EUR',
      externalId,
      payer: {
        partyIdType: 'MSISDN',
        partyId: cleanedPhone,
      },
      payerMessage: 'SwiftPass Bus Booking',
      payeeNote: `Bus ticket payment - ${payment_method || 'mobile money'}`,
    };

    console.log('Sending request to MoMo API:', requestBody);

    const response = await axios.post(
      `${baseUrl}/collection/v1_0/requesttopay`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Reference-Id': referenceId,
          'X-Target-Environment': 'sandbox',
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': secondaryKey,
        },
        timeout: 30000
      }
    );

    if (response.status === 202) {
      console.log('Payment request accepted, reference:', referenceId);
      res.status(200).json({
        success: true,
        message: 'Payment request sent successfully! Please check your phone to approve the payment.',
        referenceId,
        externalId,
        amount: paymentAmount,
        currency: 'EUR',
        phoneNumber: cleanedPhone,
        user_id: user_id,
        trip_id: trip_id,
        number_of_seats: seats,
        firstname: firstname,
        lastname: lastname,
        email: email,
        contact: cleanedPhone,
        timestamp: new Date().toISOString()
      });
    } else {
      throw new Error(`Unexpected response status: ${response.status}`);
    }
  } catch (error) {
    console.error('Error processing payment:', error.response?.data || error.message);
    
    let userMessage = 'Payment processing failed. Please try again.';
    let errorCode = 'PROCESSING_ERROR';

    if (error.response?.status === 409) {
      userMessage = 'A similar transaction is already in progress. Please wait a moment.';
      errorCode = 'DUPLICATE_TRANSACTION';
    } else if (error.response?.status === 400) {
      userMessage = 'Invalid payment details. Please check your phone number and amount.';
      errorCode = 'INVALID_DETAILS';
    } else if (error.code === 'ECONNABORTED') {
      userMessage = 'Payment request timeout. Please try again.';
      errorCode = 'TIMEOUT';
    }

    res.status(500).json({ 
      success: false,
      message: userMessage,
      code: errorCode,
      details: error.response?.data || error.message
    });
  }
});

// Check payment status by referenceId - CREATE COMPLETE RECORDS ONLY ON SUCCESS
app.get('/payment_status/:referenceId', async (req, res) => {
  const { referenceId } = req.params;
  const { 
    user_id, 
    trip_id, 
    number_of_seats, 
    firstname, 
    lastname, 
    email, 
    contact,
    payment_method,
    amount
  } = req.query;
  
  console.log('Checking payment status for:', referenceId, 'with complete booking data:', { 
    user_id, trip_id, number_of_seats, firstname, lastname, email, contact, payment_method, amount
  });
  
  try {
    await setupApiUserAndKey();
    const token = await getAccessToken();

    const response = await axios.get(
      `${baseUrl}/collection/v1_0/requesttopay/${referenceId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Target-Environment': 'sandbox',
          'Ocp-Apim-Subscription-Key': secondaryKey,
        },
        timeout: 10000
      }
    );

    const statusData = response.data;
    
    // If payment is successful, create complete records (customer, booking, payment, ticket)
    if (statusData.status === 'SUCCESSFUL' && firstname && lastname && email && contact) {
      try {
        const completeBookingData = {
          firstname: firstname,
          lastname: lastname,
          email: email,
          phoneNumber: contact,
          trip_id: parseInt(trip_id),
          number_of_seats: parseInt(number_of_seats),
          amount: parseFloat(amount || 0),
          payment_method: payment_method || 'momo'
        };

        console.log('Creating complete booking records for successful payment...');
        const result = await createCompleteBooking(completeBookingData, statusData);
        
        // Add all IDs to the response
        statusData.customer_id = result.customer_id;
        statusData.booking_id = result.booking_id;
        statusData.payment_id = result.payment_id;
        statusData.ticket_id = result.ticket_id;
        statusData.seat_update = result.seat_update; // Added seat update info
        
        console.log('✅ Complete booking records created successfully:', result);
        
      } catch (dbError) {
        console.error('❌ Database recording error:', dbError);
        statusData.dbError = 'Failed to create complete booking records';
      }
    }

    let statusMessage = '';
    switch(statusData.status) {
      case 'PENDING':
        statusMessage = 'Waiting for payment approval on your phone';
        break;
      case 'SUCCESSFUL':
        statusMessage = 'Payment completed successfully';
        break;
      case 'FAILED':
        statusMessage = 'Payment was declined or failed';
        break;
      default:
        statusMessage = `Payment status: ${statusData.status}`;
    }

    res.status(200).json({
      ...statusData,
      statusMessage,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error checking payment status:', error.response?.data || error.message);
    
    let statusCode = 500;
    let errorMessage = 'Failed to check payment status';
    
    if (error.response?.status === 404) {
      statusCode = 404;
      errorMessage = 'Payment reference not found';
    } else if (error.code === 'ECONNABORTED') {
      statusCode = 408;
      errorMessage = 'Status check timeout';
    }

    res.status(statusCode).json({ 
      success: false,
      message: errorMessage,
      code: 'STATUS_CHECK_FAILED',
      details: error.response?.data || error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Payment server is running',
    timestamp: new Date().toISOString(),
    apiUser: apiUserId ? 'Configured' : 'Not configured'
  });
});

// Callback endpoint to receive notifications from MoMo
app.post('/callback', async (req, res) => {
    console.log('MoMo callback received:', req.body);
    
    try {
        // Process the callback data
        const callbackData = req.body;
        
        // Extract relevant information from callback
        const { financialTransactionId, status, amount, currency, debitParty, creditParty } = callbackData;
        
        console.log('Payment Callback Details:', {
            transactionId: financialTransactionId,
            status: status,
            amount: amount,
            currency: currency,
            from: debitParty,
            to: creditParty
        });

        // If payment is successful, you can update your database here
        if (status === 'SUCCESSFUL') {
            console.log('Payment successful via callback for transaction:', financialTransactionId);
        }

        // Always respond with 200 OK to MoMo
        res.sendStatus(200);
    } catch (error) {
        console.error('Error processing callback:', error);
        res.sendStatus(200);
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    code: 'INTERNAL_ERROR'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    code: 'NOT_FOUND'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Payment server running at http://localhost:${PORT}`);
  console.log(`🎫 Ticket scanning endpoints available:`);
  console.log(`   GET  /ticket/:ticket_id - Check ticket status`);
  console.log(`   POST /ticket/scan - Scan ticket (mark as used)`);
  console.log(`   GET  /ticket/verify/:ticket_id - Verify ticket for QR scanning`);
});