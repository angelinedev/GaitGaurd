#include <WiFiS3.h>
#include <DFRobotDFPlayerMini.h>

// ==========================================
// 1. HARDWARE PIN DEFINITIONS
// ==========================================
const int FSR_HEEL = A0;  
const int FSR_RIGHT = A1; // Big Toe
const int FSR_LEFT = A2;  // Small Toe
const int FSR_ARCH = A3;  

const int MOTOR_HEEL = 3;
const int MOTOR_RIGHT = 5;
const int MOTOR_LEFT = 6;
const int MOTOR_ARCH = 9;

const int BTN_CALIBRATE = 2;
const int BTN_TOGGLE = 4;

// ==========================================
// 2. SYSTEM VARIABLES & TIMERS
// ==========================================
DFRobotDFPlayerMini myDFPlayer;

// State Machine Flags
bool isMonitoring = false;
bool isCalibrated = false;

// CoP Math Variables
int tareValues[4] = {0, 0, 0, 0};
float CoP_x = 50.0;
float CoP_y = 50.0;

// Non-Blocking Timers (The "Playback Guard")
unsigned long lastAudioTime = 0;
const unsigned long audioCooldown = 3500; // 3.5 seconds between voice alerts

unsigned long lastDebounceTime1 = 0;
unsigned long lastDebounceTime2 = 0;
const unsigned long debounceDelay = 250;

// WiFi Setup (Access Point Mode)
char ssid[] = "GaitGuard_Demo";  // The network name judges will connect to
char pass[] = "innovation2026";  // The password
int status = WL_IDLE_STATUS;
WiFiServer server(80);

// ==========================================
// 3. SETUP FUNCTION
// ==========================================
void setup() {
  Serial.begin(115200); // For Serial Monitor debugging
  Serial1.begin(9600);  // Hardware Serial for DFPlayer (Pins 0 and 1)

  // Configure Pins
  pinMode(MOTOR_HEEL, OUTPUT);
  pinMode(MOTOR_RIGHT, OUTPUT);
  pinMode(MOTOR_LEFT, OUTPUT);
  pinMode(MOTOR_ARCH, OUTPUT);
  pinMode(BTN_CALIBRATE, INPUT_PULLUP);
  pinMode(BTN_TOGGLE, INPUT_PULLUP);

  // Initialize DFPlayer
  Serial.println("Initializing DFPlayer...");
  if (!myDFPlayer.begin(Serial1)) {
    Serial.println("DFPlayer Error! Check TX/RX connections.");
  } else {
    myDFPlayer.volume(25); // Set volume (0 to 30)
    delay(500); // Brief delay just for initial boot stability
    myDFPlayer.play(1); // PLAY 0001.mp3: "System Initialized"
    lastAudioTime = millis() + 4000; // Give it time to speak
  }

  // Initialize WiFi AP
  Serial.println("Starting Access Point...");
  status = WiFi.beginAP(ssid, pass);
  if (status != WL_AP_LISTENING) {
    Serial.println("Creating access point failed");
    while (true); // Halt if WiFi fails
  }
  delay(10000); // Wait for AP to establish
  server.begin();
  Serial.print("Web Server active at IP: ");
  Serial.println(WiFi.localIP());
}

// ==========================================
// 4. MAIN LOOP (NON-BLOCKING)
// ==========================================
void loop() {
  handleButtons();
 
  if (isMonitoring && isCalibrated) {
    processGaitData();
  }

  handleWiFiClient();
}

// ==========================================
// 5. BUTTON HANDLING (DEBOUNCED)
// ==========================================
void handleButtons() {
  unsigned long currentTime = millis();

  // Button 1: Calibrate / Tare
  if (digitalRead(BTN_CALIBRATE) == LOW && (currentTime - lastDebounceTime1 > debounceDelay)) {
    calibrateSensors();
    isCalibrated = true;
    myDFPlayer.play(2); // PLAY 0002.mp3: "Calibration Complete"
    lastAudioTime = currentTime;
    lastDebounceTime1 = currentTime;
  }

  // Button 2: Toggle Monitoring
  if (digitalRead(BTN_TOGGLE) == LOW && (currentTime - lastDebounceTime2 > debounceDelay)) {
    isMonitoring = !isMonitoring;
    if (!isMonitoring) {
      stopAllMotors();
      myDFPlayer.play(7); // PLAY 0007.mp3: "Session Paused"
      lastAudioTime = currentTime;
    }
    lastDebounceTime2 = currentTime;
  }
}

// ==========================================
// 6. CALIBRATION LOGIC
// ==========================================
void calibrateSensors() {
  Serial.println("Taring sensors...");
  // Take 10 readings and average them to find the "resting" weight
  long sum[4] = {0,0,0,0};
  for(int i=0; i<10; i++){
    sum[0] += analogRead(FSR_HEEL);
    sum[1] += analogRead(FSR_RIGHT);
    sum[2] += analogRead(FSR_LEFT);
    sum[3] += analogRead(FSR_ARCH);
    delay(10); // Safe delay during calibration only
  }
  tareValues[0] = sum[0]/10;
  tareValues[1] = sum[1]/10;
  tareValues[2] = sum[2]/10;
  tareValues[3] = sum[3]/10;
}

// ==========================================
// 7. SENSOR MATH & HAPTIC/AUDIO TRIGGERS
// ==========================================
void processGaitData() {
  // Read and adjust for tare (prevent negative numbers)
  int valHeel = max(0, analogRead(FSR_HEEL) - tareValues[0]);
  int valRight = max(0, analogRead(FSR_RIGHT) - tareValues[1]);
  int valLeft = max(0, analogRead(FSR_LEFT) - tareValues[2]);
  int valArch = max(0, analogRead(FSR_ARCH) - tareValues[3]);

  int totalForce = valHeel + valRight + valLeft + valArch;

  // Reset motors every loop, only turn on if condition met
  stopAllMotors();

  if (totalForce > 50) { // Foot is actively on the ground
   
    // CoP Calculation (Virtual Coordinates: X=0 to 100)
    // Left=30, Right=70. Heel Y=10, Toes Y=90, Arch Y=50.
    CoP_x = ((valLeft * 30.0) + (valRight * 70.0) + (valHeel * 50.0) + (valArch * 20.0)) / totalForce;
    CoP_y = ((valLeft * 90.0) + (valRight * 90.0) + (valHeel * 10.0) + (valArch * 50.0)) / totalForce;

    // --- TRIGGER LOGIC ---
    unsigned long currentTime = millis();
    bool canPlayAudio = (currentTime - lastAudioTime > audioCooldown);

    // 1. Heavy Heel Strike
    if (valHeel > 800) {
      analogWrite(MOTOR_HEEL, 200);
      if(canPlayAudio) { myDFPlayer.play(3); lastAudioTime = currentTime; } // 0003.mp3
    }
   
    // 2. Leaning Left (Supination)
    else if (CoP_x < 40.0 && valLeft > 300) {
      analogWrite(MOTOR_LEFT, 200);
      if(canPlayAudio) { myDFPlayer.play(4); lastAudioTime = currentTime; } // 0004.mp3
    }
   
    // 3. Leaning Right (Pronation)
    else if (CoP_x > 60.0 && valRight > 300) {
      analogWrite(MOTOR_RIGHT, 200);
      if(canPlayAudio) { myDFPlayer.play(5); lastAudioTime = currentTime; } // 0005.mp3
    }
   
    // 4. Arch Drag
    else if (valArch > 400 && valHeel < 100 && valRight < 100) {
      analogWrite(MOTOR_ARCH, 200);
      if(canPlayAudio) { myDFPlayer.play(6); lastAudioTime = currentTime; } // 0006.mp3
    }
  }
}

void stopAllMotors() {
  analogWrite(MOTOR_HEEL, 0);
  analogWrite(MOTOR_RIGHT, 0);
  analogWrite(MOTOR_LEFT, 0);
  analogWrite(MOTOR_ARCH, 0);
}

// ==========================================
// 8. WIFI WEB SERVER DASHBOARD
// ==========================================
void handleWiFiClient() {
  WiFiClient client = server.available();
  if (client) {
    String currentLine = "";
    while (client.connected()) {
      if (client.available()) {
        char c = client.read();
        if (c == '\n') {
          if (currentLine.length() == 0) {
            // HTTP headers
            client.println("HTTP/1.1 200 OK");
            client.println("Content-type:text/html");
            client.println("Connection: close");
            client.println("Refresh: 1"); // Auto-refresh every 1 second
            client.println();
           
            // HTML Dashboard
            client.println("<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'>");
            client.println("<style>body{font-family: Arial; text-align: center; background-color: #222; color: #fff;}");
            client.println(".card{background: #333; padding: 20px; border-radius: 10px; margin: 10px; display: inline-block;}</style></head><body>");
            client.println("<h2>GaitGuard Live Telemetry</h2>");
           
            client.print("<div class='card'><h3>Center of Pressure</h3>");
            client.print("<p>X-Axis (L/R Balance): "); client.print(CoP_x); client.println("</p>");
            client.print("<p>Y-Axis (Heel/Toe): "); client.print(CoP_y); client.println("</p></div>");

            client.print("<div class='card'><h3>System Status</h3>");
            if(isMonitoring) { client.print("<p style='color:lime;'>Active & Monitoring</p>"); }
            else { client.print("<p style='color:red;'>Paused</p>"); }
            client.println("</div></body></html>");
            break;
          } else {
            currentLine = "";
          }
        } else if (c != '\r') {
          currentLine += c;
        }
      }
    }
    client.stop();
  }
}