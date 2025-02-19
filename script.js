let selectedDate = null;
let selectedTime = null;

async function submitBooking() {
    const firstName = document.getElementById('firstName').value;
    const lastName = document.getElementById('lastName').value;
    const phone = document.getElementById('phone').value;
    const email = document.getElementById('email').value;
    const service = document.getElementById('service').value;

    if (!firstName || !lastName || !phone || !service || !selectedDate || !selectedTime) {
        alert('Please fill in all required fields');
        return;
    }

    const bookingData = {
        firstName,
        lastName,
        phone,
        email,
        service,
        date: selectedDate.toISOString().split('T')[0],
        time: selectedTime
    };

    try {
        const response = await fetch('/submit_booking', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(bookingData)
        });

        if (response.ok) {
            alert('Booking confirmed! We will contact you to confirm your appointment.');
            location.reload();
        } else {
            throw new Error('Failed to save booking');
        }
    } catch (error) {
        console.error('Error submitting booking:', error);
        alert('There was an error booking your appointment. Please try again.');
    }
}

// Ensure script is loaded after the DOM
document.addEventListener('DOMContentLoaded', () => {
    populateDates();
    fetchExistingEvents();
});
