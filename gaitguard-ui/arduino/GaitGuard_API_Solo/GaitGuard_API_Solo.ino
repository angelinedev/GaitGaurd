#include "WiFiS3.h"

// --- WIFI CONFIGURATION (Access Point Mode) ---
char ssid[] = "GaitGuard_Live"; // The name judges will see on their phones
char pass[] = "Techxora26";     // MUST be at least 8 characters!
int status = WL_IDLE_STATUS;
WiFiServer server(80);

// --- PIN MAPPING & VARIABLES ---
const int fsrPins[4] = {A0, A1, A2, A3};
const int motorPins[4] = {3, 5, 6, 9};  
const float fsrX[4] = {150.0, 210.0, 90.0, 100.0};
const float fsrY[4] = {430.0, 70.0, 90.0, 250.0};
int fsrBaseline[4] = {0, 0, 0, 0};
float currentForces[4] = {0, 0, 0, 0};
float copX = 150.0;
float copY = 250.0;
float totalForce = 0.0;
unsigned long lastTelemetryTime = 0;
const int telemetryInterval = 100;
unsigned long lastAudioTime = 0;
const int audioCooldown = 3000;    

unsigned long pronationStartTime = 0;
const int errorConfirmationTime = 50;

void setup() {
  Serial.begin(115200);  
  Serial1.begin(9600);  
 
  // 1. Configure RA4M1 for 14-bit ADC Precision
  analogReadResolution(14);

  // 2. Initialize Motor Pins
  for (int i = 0; i < 4; i++) {
    pinMode(motorPins[i], OUTPUT);
    digitalWrite(motorPins[i], LOW);
  }

  // --- AUDIO INTEGRATION: Boot Sequence ---
  delay(500); // Give DFPlayer half a second to power up
  playAudio(1); // 0001.mp3: "System Initialized. Please stand still."
  // ----------------------------------------

  // 3. CREATE THE ACCESS POINT
  Serial.print("Creating Access Point: ");
  Serial.println(ssid);
 
  status = WiFi.beginAP(ssid, pass);
  if (status != WL_AP_LISTENING) {
    Serial.println("Creating access point failed! Check password length.");
    while (true);
  }
 
  delay(10000); // Wait for AP stabilization
 
  server.begin();
  Serial.println("\nAP Active and Broadcasting!");
  Serial.print("Tell the Judge to connect to WiFi: ");
  Serial.println(ssid);
  Serial.print("Then open their browser to: ");
  Serial.println(WiFi.localIP());

  // 4. System Calibration (Tare)
  calibrateSensors();
}

void loop() {
  readSensors();
  calculateCoP();
  evaluateStance();
  handleWebServer();
}

// ==========================================
// CORE LOGIC FUNCTIONS
// ==========================================

void calibrateSensors() {
  Serial.println("Calibrating... Keep foot OFF the insole.");
  delay(2000);
 
  long sums[4] = {0, 0, 0, 0};
  for (int i = 0; i < 50; i++) {
    for (int j = 0; j < 4; j++) {
      sums[j] += analogRead(fsrPins[j]);
    }
    delay(10);
  }
 
  for (int j = 0; j < 4; j++) {
    fsrBaseline[j] = sums[j] / 50;
    Serial.print("Baseline "); Serial.print(j); Serial.print(": ");
    Serial.println(fsrBaseline[j]);
  }
  Serial.println("Calibration Complete.");

  // --- AUDIO INTEGRATION: Calibration Done ---
  delay(500); // Guarantee we pass the 3000ms audioCooldown from boot
  playAudio(2); // 0002.mp3: "Calibration Complete"
  // -------------------------------------------
}

void readSensors() {
  totalForce = 0.0;
  for (int i = 0; i < 4; i++) {
    long averageValue = 0;
    // Take 10 rapid samples to filter out audio ripple
    for(int s = 0; s < 10; s++) {
      averageValue += analogRead(fsrPins[i]);
    }
    int rawValue = averageValue / 10;
   
    float force = (float)(rawValue - fsrBaseline[i]);
    currentForces[i] = (force > 80.0) ? force : 0.0; // Increased deadband slightly
    totalForce += currentForces[i];
  }
}

void calculateCoP() {
  if (totalForce > 100.0) { 
    float sumX = 0;
    float sumY = 0;
   
    for (int i = 0; i < 4; i++) {
      sumX += currentForces[i] * fsrX[i];
      sumY += currentForces[i] * fsrY[i];
    }
   
    copX = sumX / totalForce;
    copY = sumY / totalForce;
  }
}

void evaluateStance() {
if (totalForce < 500.0) {
for(int i=0; i<4; i++) digitalWrite(motorPins[i], LOW);
pronationStartTime = 0; // Reset timer when foot is lifted
return;
}

// 1. Thresholds
bool isSupinating = (copX < 120.0);
bool isPronating = (copX > 206.0);

// 2. GAIT GATING (The "Secret Sauce")
// If the Heel (FSR 0) is already off the ground, the Big Toe spike
// is likely just a natural "Toe-Off" push. We ignore it.
bool isMidStance = (currentForces[0] > 1000.0);


// 3. TRIGGER LOGIC with Confirmation Timer
if (isPronating && isMidStance) {
if (pronationStartTime == 0) {
pronationStartTime = millis(); // Start the stopwatch
}

// Only trigger if the lean has persisted longer than our confirmation time
if (millis() - pronationStartTime > errorConfirmationTime) {
analogWrite(motorPins[1], 200);
playAudio(5); // "Leaning right"
}
}
else {
pronationStartTime = 0; // Reset if the lean stops
digitalWrite(motorPins[1], LOW);
}

// Handle other alerts (Heel, Supination, etc.) normally
  
  if (currentForces[0] > 250.0) {
    analogWrite(motorPins[0], 200); // Heel motor
    delay(50);
    analogWrite(motorPins[0], 0);
    playAudio(3); // 0003.mp3: "Warning: Heavy heel strike detected"
  }
  // 2. Arch Drag (High mid-foot pressure without toe/heel)
  else if (currentForces[3] > 150.0 && currentForces[0] > 120.0 && currentForces[1] > 120.0) {
    analogWrite(motorPins[3], 200); // Arch motor
    delay(50);
    analogWrite(motorPins[3], 0);
    playAudio(6); // 0006.mp3: "Caution: Dragging detected"
  }
  // 3. Supinating (Leaning left/outward)
  else if (isSupinating) {
    analogWrite(motorPins[2], 150); // Small toe motor
    delay(50);
    analogWrite(motorPins[2], 0);
    playAudio(4); // 0004.mp3: "Correct balance: Leaning too far left"
  }
  // 4. Pronating (Leaning right/inward)
  else if (isPronating) {
    analogWrite(motorPins[1], 150); // Big toe motor
    delay(50);
    analogWrite(motorPins[1], 0);
    playAudio(5); // 0005.mp3: "Correct balance: Leaning too far right"
  }
}

// ==========================================
// TELEMETRY & AUDIO FUNCTIONS
// ==========================================

void handleWebServer() {
  WiFiClient client = server.available();
  if (client) {
    boolean currentLineIsBlank = true;
    while (client.connected()) {
      if (client.available()) {
        char c = client.read();
        if (c == '\n' && currentLineIsBlank) {
          client.println("HTTP/1.1 200 OK");
          client.println("Content-Type: application/json");
          client.println("Connection: close");
          client.println("Access-Control-Allow-Origin: *");
          client.println();

          client.print("{\"F1\":"); client.print(currentForces[0]);
          client.print(",\"F2\":"); client.print(currentForces[1]);
          client.print(",\"F3\":"); client.print(currentForces[2]);
          client.print(",\"F4\":"); client.print(currentForces[3]);
          client.print(",\"CoPX\":"); client.print(copX);
          client.print(",\"CoPY\":"); client.print(copY);
          client.println("}");
          break;
        }
        if (c == '\n') currentLineIsBlank = true;
        else if (c != '\r') currentLineIsBlank = false;
      }
    }
    delay(1);
    client.stop();
  }
}

void playAudio(int trackNumber) {
  if (millis() - lastAudioTime > audioCooldown) {

    byte playCommand[8] = {
      0x7E,       // Start
      0xFF,       // Version
      0x06,       // Length
      0x12,       // Command: play MP3 folder
      0x00,       // No feedback
      0x00,       // High byte
      (byte)trackNumber, // Low byte (0001, 0002...)
      0xEF        // End
    };

    for (int i = 0; i < 8; i++) {
      Serial1.write(playCommand[i]);
    }

    lastAudioTime = millis();
  }
}