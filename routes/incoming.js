var cookieParser = require('cookie-parser');
var express      = require('express');
var pg           = require('pg');
var sys          = require('sys');
var strings      = require('../public/javascripts/strings');

var router       = express.Router();

// Twilio Credentials
var accountSid   = 'ACf55ee981f914dc797efa85947d9f60b8';
var authToken    = 'cc3c8f0a7949ce40356c029579934c0f';
var twilio       = require('twilio');
var twilioClient = require('twilio')(accountSid, authToken);

/*
 * The 'rideStages' var acts as an enum to represent where the current
 * rider is in the request process.
 *
 * DRIVER            : All drivers rideStages is marked DRIVER (default for drivers)
 * NOTHING           : Before the request, all riders have sent nothing (default for riders)
 * AWAITING_LOCATION : The server has asked for their location, waiting for answer
 * AWAITING_TRAILER  : The server has asked if they need a trailer, waiting for answer
 * CONTACTING_DRIVER : The server has told them a driver will contact them
 */
var rideStages = {
    DRIVER             : "driver",
    NOTHING            : "nothing",
    AWAITING_LOCATION  : "awaitingLocation",
    AWAITING_TRAILER   : "awaitingTrailer",
    CONTACTING_DRIVER  : "contactingDriver",
    AWAITING_DRIVER    : "awaitingDrivier"
}

var TWILIO_NUMBER = '+18443359847';


/********************/
/* HELPER FUNCTIONS */
/********************/
function isSenderDriver(senderNumber) {
    if (/* Sender number found in driver DB table*/0) {
        return true;
    } else {
        return false;
    }
}

function getRideStage(request, isDriver) {
    var defaultReturnVal;
    if (isDriver) {
        defaultReturnVal = rideStages.DRIVER;
    } else {
        defaultReturnVal =  rideStages.NOTHING;
    }

    if (request.cookies != null) {
        sys.log("getRideStage: cookies are NOT null");

        if (request.cookies.rideStage != null) {
            sys.log("getRideStage: rideStage is NOT null, returning " + request.cookies.rideStage);
            return request.cookies.rideStage;
        } else {
            sys.log("getRideStage: rideStage IS null, returning " + defaultReturnVal);
            return defaultReturnVal;
        }
    } else {
        sys.log("getRideStage: cookies ARE null, returning " + defaultReturnVal);

        return defaultReturnVal;
    }
}

function addRiderNumToDb(from) {
    pg.connect(process.env.DATABASE_URL, function(err, client) {
        if (!err) {
            // Look for rider
            var query = client.query("SELECT num FROM riders WHERE num = '" + from + "'", function(err, result) {
                if (!err) {
                    if (result.rows.length == 0) {
                        // Rider is not in DB yet, add them
                        var addRiderQuery = client.query("INSERT INTO riders (num, onride) VALUES ('" + from + "', false)", function(err, result) {
                            if (!err) {
                                sys.log("Rider " + from + " successfully added to DB");
                            } else {
                                sys.log("Rider " + from + " unsuccessfully added to DB, " + err);
                            }
                        });
                    } else {
                        // Rider already exists in DB
                        sys.log("Rider already exists in DB");
                    }
                } else {
                    sys.log("Error querying DB to see if rider exists already, " + err);
                }
            });
        } else {
            sys.log("Error connecting to DB, " + err);
        }
    });
}

function verifyRiderLocation(msg) {
    for (var i = 1; i <= strings.availableLocations.length; i++) {
        if (parseInt(msg) == i) {
            return true;
        }
    }

    return false;
}

function verifyTrailerDecision(msg, needTrailer) {
    sys.log("verifyTrailerDecision");
    for (var i = 0; i < strings.validYesWords.length; i++) {
        if (msg == strings.validYesWords[i]) {
            sys.log("verifyTrailerDecision: message is affirmative, needTrailer.doesNeed set to true");
            needTrailer.doesNeed = true;
            return true;
        } else if (msg == strings.validNoWords[i]) {
            sys.log("verifyTrailerDecision: message is negative, needTrailer.doesNeed set to false");
            needTrailer.doesNeed = false;
            return true;
        }
    }

    sys.log("verifyTrailerDecision: message is unrecognized, returning false");
    return false;
}

function isRideStageReset(res, msg) {
    sys.log("isRideStageReset: received message is " + msg);

    if (msg == "resetridestage") {
        sys.log("isRideStageReset: message was a reset");
        var response = new twilio.TwimlResponse();
        var responseText = "Ok, rideStage has been reset to NOTHING";
        response.sms(responseText);
        res.cookie('rideStage', rideStages.NOTHING);
        sys.log("isRideStageReset: Just set the rideStage to " + rideStages.NOTHING);
        res.send(response.toString(), {
            'Content-Type':'text/xml'
        }, 200);

        sys.log("isRideStageReset: returning true");
        return true;
    }

    sys.log("isRideStageReset: message was not a reset, returning false");
    return false;
}

function isQuickDriverSignUp(res, message, from) {
    if (message.toLowerCase() == "signupdriver") {
        pg.connect(process.env.DATABASE_URL, function(err, client) {
            if (!err) {
                sys.log("isQuickDriverSignUp: connected to DB");
                // Create query to add driver
                var queryString = "INSERT INTO drivers (num, working, on_ride, current_zone, has_trailer, rating, last_payment) VALUES ('"
                        + from + "', true, false, 1, true, 100, '2015-02-26')";

                var query = client.query(queryString, function(err, result) {
                    var responseText = "";

                    if (!err) {
                        sys.log("Driver added to DB successfully");
                        responseText += "Ok, you are now registered as a driver!";
                        res.cookie('rideStage', rideStages.DRIVER);
                    } else {
                        sys.log("Error adding driver to DB, " + err);
                        responseText += "Error adding driver, " + err;
                    }

                    var response = new twilio.TwimlResponse();
                    response.sms(responseText);
                    res.send(response.toString(), {
                        'Content-Type':'text/xml'
                    }, 200);
                });
            } else {
                sys.log("Error connecting to DB, " + err);
            }
        });

        return true;
    }

    sys.log("isQuickDriverSignUp: message was not a driver sign up, returning false");
    return false;
}

function searchForDriver(from, location, needTrailer) {
    sys.log("searchForDriver");
    pg.connect(process.env.DATABASE_URL, function(err, client) {
        if (!err) {
            sys.log("searchForDriver: connected to DB");
            // Look for driver
            var queryString = "SELECT num FROM drivers WHERE working = 'true' AND on_ride = 'false' AND current_zone = " + location;
            if (needTrailer) {
                queryString += " AND has_trailer = 'true'";
            }

            var query = client.query(queryString, function(err, result) {
                if (!err) {
                    if (result.rows.length == 0) {
                        // No drivers available
                        sys.log("searchForDriver: No drivers available");
                        sendNoDriversText(from);
                    } else {
                        sys.log("searchForDriver: Drivers available");
                        // For now, just grab first driver
                        var driver = result.rows[0];

                        var driverNumber;
                        if (driver.num != null) {
                            sys.log("searchForDriver: Found driver " + driver.num);
                            driverNumber = driver.num;
                        } else {
                            sys.log("searchForDriver: driver.num is NULL");
                        }

                        textDriverForConfirmation(driverNumber)
                    }
                } else {
                    sys.log("Error querying DB to find drivers, " + err);
                }
            });
        } else {
            sys.log("Error connecting to DB, " + err);
        }
    });
}

/**********************/
/* REPLYING FUNCTIONS */
/**********************/
function handleRiderText(req, res, message, from, riderStage) {
    switch (riderStage) {
        case rideStages.NOTHING:
            sys.log('handleRiderText: case NOTHING');
            if (message.toUpperCase() === strings.keywordRide) {
                sys.log('Ride request received');

                addRiderNumToDb(from);

                // Send response asking for location
                requestLocation(res, false);
            } else {
                defaultHelpResponse(res);
            }
            break;

        case rideStages.AWAITING_LOCATION:
            sys.log('handleRiderText: case AWAITING_LOCATION');
            if (verifyRiderLocation(message)) {
                // Send response asking for needed trailer
                sys.log('Location received');
                res.cookie('originLocation', message);
                sys.log('Just set the location cookie to ' + message);
                requestTrailerInfo(res, false);
            } else {
                // Send response asking them to resend their location correctly this time
                sys.log('Invalid response for location');
                requestLocation(res, true);
            }
            break;

        case rideStages.AWAITING_TRAILER:
            sys.log('handleRiderText: case AWAITING_TRAILER');
            var needTrailer = { doesNeed: false };

            if (verifyTrailerDecision(message, needTrailer)) {
                sys.log('Trailer decision received');
                var location = req.cookies.originLocation;
                sys.log("Just received location from cookies as " + location);

                res.cookie('rideStage', rideStages.CONTACTING_DRIVER);
                sys.log("handleRiderText: Just set the rideStage to " + rideStages.CONTACTING_DRIVER);
                res.cookie('Content-Type', 'text/xlm');
                sys.log("handleRiderText: Just set the Content-Type to text/xlm");

                sendWaitText(res);
                sys.log("handleRiderText: finished sendWaitText");
                searchForDriver(from, location, needTrailer.doesNeed);
            } else {
                sys.log('Invalid response for trailer decision');
                requestTrailerInfo(res, true);
            }
            break;

        case rideStages.CONTACTING_DRIVER:
            sys.log('handleRiderText: case CONTACTING_DRIVER');
            sys.log('Received text from waiting rider');
            sendWaitText(res);
            break;
    }
}

function handleDriverText(res, message, from) {
    // Do something
}

function requestLocation (res, resend) {
    var locationXml = "";
    for (var i = 1; i <= strings.availableLocations.length; i++) {
        locationXml += (i + ": " + strings.availableLocations[i-1]);

        if (i != strings.availableLocations.length+1) {
            locationXml += "\n";
        }
    }

    var responseText = "";

    if (resend) {
        responseText += strings.resendText;
    }

    responseText += strings.askLocation + locationXml;

    var response = new twilio.TwimlResponse();
    response.sms(responseText);
    res.cookie('rideStage', rideStages.AWAITING_LOCATION);
    sys.log("requestLocation: Just set the rideStage to " + rideStages.AWAITING_LOCATION);
    res.send(response.toString(), {
        'Content-Type':'text/xml'
    }, 200);
}

function requestTrailerInfo(res, resend) {
    var response = new twilio.TwimlResponse();
    response.sms(strings.askTrailer);
    res.cookie('rideStage', rideStages.AWAITING_TRAILER);
    sys.log("requestTrailerInfo: Just set the rideStage to " + rideStages.AWAITING_TRAILER);
    res.send(response.toString(), {
        'Content-Type':'text/xml'
    }, 200);
}

function sendWaitText(res) {
    sys.log("sendWaitText");
    var response = new twilio.TwimlResponse();
    response.sms(strings.waitText);
    //res.cookie('rideStage', rideStages.CONTACTING_DRIVER);
    //sys.log("sendWaitText: Just set the rideStage to " + rideStages.CONTACTING_DRIVER);
    res.send(response.toString(), {}, 200);
    sys.log("sendWaitText: text sent");
}

function defaultHelpResponse(res) {
    var responseText = strings.resendText + strings.helpText;
    var response = new twilio.TwimlResponse();
    response.sms(responseText);
    res.send(response.toString(), {
        'Content-Type':'text/xml'
    }, 200);
}

function sendNoDriversText(rider) {
    /*
     * Set rideStage cookie to rideStages.AWAITING_DRIVER
     */
    twilioClient.sms.messages.create({
        to: rider,
        from: TWILIO_NUMBER,
        body: strings.noDriversAvailable
    }, function(error, message) {
        if (!error) {
            // Record time sent, so if nothing comes up in 30 mins, let them know
        } else {
            sys.log('Failed to send noDriversText, ' + error);
        }
    });
}

function textDriverForConfirmation(driverNumber) {
    twilioClient.sms.messages.create({
        to: driverNumber,
        from: TWILIO_NUMBER,
        body: "Do you want to accept a new ride request?"
    }, function(error, message) {
        if (!error) {
            // Record time sent, so if nothing comes up in 30 mins, let them know
        } else {
            sys.log('Failed to send noDriversText, ' + error);
        }
    });
}

var receiveIncomingMessage = function(req, res, next) {
    var message   = req.body.Body;
    var from      = req.body.From;
    var isDriver  = isSenderDriver(from);
    var rideStage = getRideStage(req, isDriver);

    if (isRideStageReset(res, message)) {
        sys.log('receiveIncomingMessage: rideStage successfully reset, returning');
        return;
    } else if (isQuickDriverSignUp(res, message, from)) {
        sys.log('receiveIncomingMessage: driver signed up, returning');
        return;
    }

    if (isDriver) {
        sys.log('From: ' + from + ', Status: Driver, Message: ' + message + ', rideStage: ' + rideStage);
    } else {
        sys.log('From: ' + from + ', Status: Rider, Message: ' + message + ', rideStage: ' + rideStage);
    }

    if (!isDriver) {
        // Handling rider texts
        handleRiderText(req, res, message, from, rideStage);
    } else {
        // Handling driver texts
        handleDriverText(res, message, from);
    }
}

/* Incoming SMS */
router.post('/', [receiveIncomingMessage]);

module.exports = router;
