const nodemailer = require('nodemailer');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { to_email, to_name, subject, message, invoice_number, pdf_base64, shared_secret } = payload;

  // Simple shared-secret check so random visitors can't use your Gmail to spam people.
  if (!process.env.APP_SHARED_SECRET || shared_secret !== process.env.APP_SHARED_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
  }

  if (!to_email || !subject) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing to_email or subject' }) };
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    const mailOptions = {
      from: `"Rent Ledger" <${process.env.GMAIL_USER}>`,
      to: to_email,
      subject: subject,
      text: message || '',
      attachments: [],
    };

    if (pdf_base64) {
      mailOptions.attachments.push({
        filename: `${invoice_number || 'invoice'}.pdf`,
        content: pdf_base64,
        encoding: 'base64',
      });
    }

    await transporter.sendMail(mailOptions);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String((err && err.message) || err) }),
    };
  }
};
