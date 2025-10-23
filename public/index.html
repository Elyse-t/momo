<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MTN MoMo Payment</title>
  <link
    href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css"
    rel="stylesheet"
  />
</head>
<body class="p-4">
  <div class="container">
    <h2>Pay with MTN MoMo</h2>

    <form id="paymentForm" class="mb-3">
      <div class="mb-3">
        <label for="phoneNumber" class="form-label">Phone Number</label>
        <input
          type="tel"
          id="phoneNumber"
          class="form-control"
          placeholder="e.g. 250788123456"
          required
        />
      </div>
      <div class="mb-3">
        <label for="amount" class="form-label">Amount</label>
        <input
          type="number"
          id="amount"
          class="form-control"
          min="1"
          step="0.01"
          required
        />
      </div>
      <button type="submit" class="btn btn-primary">Pay Now</button>
    </form>

    <div id="message" class="mb-3"></div>
    <div id="status"></div>
  </div>

  <script>
    const form = document.getElementById('paymentForm');
    const messageDiv = document.getElementById('message');
    const statusDiv = document.getElementById('status');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      messageDiv.textContent = '';
      statusDiv.textContent = '';

      const phoneNumber = document.getElementById('phoneNumber').value.trim();
      const amount = document.getElementById('amount').value.trim();

      if (!phoneNumber || !amount) {
        messageDiv.textContent = 'Please fill in all fields.';
        return;
      }

      messageDiv.textContent = 'Sending payment request...';

      try {
        // Send payment request
        const res = await fetch('/process_payment', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ phoneNumber, amount }),
        });

        const data = await res.json();

        if (!res.ok) {
          messageDiv.textContent = `Error: ${data.message || 'Payment failed'}`;
          return;
        }

        messageDiv.textContent = 'Payment request sent! Checking status...';

        // Poll status every 5 seconds
        const referenceId = data.referenceId;
        const interval = setInterval(async () => {
          const statusRes = await fetch(`/payment_status/${referenceId}`);
          const statusData = await statusRes.json();

          statusDiv.textContent = `Status: ${statusData.status}`;

          if (statusData.status !== 'PENDING') {
            clearInterval(interval);
            if (statusData.status === 'SUCCESSFUL') {
              messageDiv.textContent = '✅ Payment successful!';
            } else {
              messageDiv.textContent = '❌ Payment failed or cancelled.';
            }
          }
        }, 5000);
      } catch (err) {
        messageDiv.textContent = 'An error occurred: ' + err.message;
      }
    });
  </script>
</body>
</html>
