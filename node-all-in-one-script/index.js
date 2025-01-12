const os = require("os");
const fs = require("fs");
const nodemailer = require("nodemailer");
const pm2 = require("pm2");
const { execSync } = require("child_process");
const path = require("path");
require("dotenv").config({ path: "TODO", override: true }); // Load environment variables from .env

const lastReadTimeFile = path.join(__dirname, "lastReadTime.json");

// Configuration via environment variables
const config = {
  freeDiskThreshold: parseFloat(process.env.FREE_DISK_THRESHOLD) || 20, // in percentage
  freeRamThreshold: parseFloat(process.env.FREE_RAM_THRESHOLD) || 10, // in percentage
  cpuUtilThreshold: parseFloat(process.env.CPU_UTIL_THRESHOLD) || 100, // in percentage
  pm2Apps: process.env.PM2_APPS ? process.env.PM2_APPS.split(",") : [], // comma-separated app names
  processes: process.env.PROCESSES ? process.env.PROCESSES.split(",") : [], // comma-separated process names
  logFiles: process.env.LOG_FILES ? process.env.LOG_FILES.split(",") : [], // comma-separated log file paths
  searchWords: process.env.SEARCH_WORDS ? process.env.SEARCH_WORDS.split(",") : [], // Comma-separated words
  emailConfig: {
    host: process.env.SMTP_HOST || "smtp.example.com",
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || "your_email@example.com",
    secure: false,
    pass: process.env.SMTP_PASS || "your_password",
    to: process.env.NOTIFY_EMAIL || "admin@example.com",
  },
};

const lastReadTime = {};
Object.assign(lastReadTime, loadLastReadTime());

function loadLastReadTime() {
  try {
    if (fs.existsSync(lastReadTimeFile)) {
      const data = fs.readFileSync(lastReadTimeFile, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Error loading last read time file:", error);
  }
  return {};
}

function saveLastReadTime() {
  try {
    fs.writeFileSync(lastReadTimeFile, JSON.stringify(lastReadTime, null, 2), "utf8");
  } catch (error) {
    console.error("Error saving last read time file:", error);
  }
}

async function sendEmail(subject, message) {
  const transporter = nodemailer.createTransport({
    host: config.emailConfig.host,
    port: config.emailConfig.port,
    secure: config.emailConfig.secure,
    auth: {
      user: config.emailConfig.user,
      pass: config.emailConfig.pass,
    },
  });

  const mailOptions = {
    from: config.emailConfig.user,
    to: config.emailConfig.to,
    subject,
    text: message,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("Email sent successfully");
  } catch (error) {
    console.error("Error sending email:", error);
  }
}

function checkDiskSpace() {
  try {
    const output = execSync("df -h --output=pcent / | tail -1").toString().trim();
    const freeDiskPercent = 100 - parseInt(output.replace("%", ""));
    if (freeDiskPercent < config.freeDiskThreshold) {
      return `Low disk space: Only ${freeDiskPercent}% free.`;
    }
  } catch (error) {
    console.error("Error checking disk space:", error);
  }
  return null;
}

function checkRAM() {
  const freeMemPercent = (os.freemem() / os.totalmem()) * 100;
  if (freeMemPercent < config.freeRamThreshold) {
    return `Low RAM: Only ${freeMemPercent.toFixed(2)}% free.`;
  }
  return null;
}

function checkCPU() {
  const cpus = os.cpus();
  const totalLoad = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const usage = (1 - cpu.times.idle / total) * 100;
    return acc + usage;
  }, 0);
  const avgLoad = totalLoad / cpus.length;
  if (avgLoad > config.cpuUtilThreshold) {
    return `High CPU utilization: Average load is ${avgLoad.toFixed(2)}%.`;
  }
  return null;
}

function checkPM2Apps() {
  return new Promise((resolve) => {
    pm2.connect((err) => {
      if (err) {
        console.error("Error connecting to PM2:", err);
        resolve(null);
        return;
      }

      pm2.list((err, list) => {
        pm2.disconnect();
        if (err) {
          console.error("Error listing PM2 apps:", err);
          resolve(null);
          return;
        }

        const missingApps = config.pm2Apps.filter(
          (app) => !list.some((pm2App) => pm2App.name === app && pm2App.pm2_env.status === "online")
        );

        if (missingApps.length > 0) {
          resolve(`PM2 apps not running: ${missingApps.join(", ")}.`);
        } else {
          resolve(null);
        }
      });
    });
  });
}

function checkProcesses() {
  const missingProcesses = config.processes.filter((process) => {
    try {
      execSync(`pgrep -f ${process}`);
      return false; // Process is running
    } catch {
      return true; // Process not running
    }
  });

  if (missingProcesses.length > 0) {
    return `Processes not running: ${missingProcesses.join(", ")}.`;
  }
  return null;
}

async function checkLogFiles() {
  const issues = [];

  for (const file of config.logFiles) {
    try {
      const stats = fs.statSync(file);
      const readFrom = lastReadTime[file] || 0;

      const logIssues = await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file, { start: readFrom, encoding: "utf8" });
        let buffer = []; // Buffer to store the last few lines
        const foundEntries = []; // Array to store matching lines + 2 lines after
        const lines = [];
        let currentLine = "";

        // Process the stream chunk by chunk
        stream.on("data", (chunk) => {
          const chunkLines = chunk.split("\n");
          chunkLines[0] = currentLine + chunkLines[0]; // Append leftover line from previous chunk
          currentLine = chunkLines.pop(); // Save the last line for the next chunk
          lines.push(...chunkLines);

          for (const line of chunkLines) {
            buffer.push(line); // Add the current line to the buffer
            if (buffer.length > 3) buffer.shift(); // Keep only the last 3 lines in the buffer

            const lowerCaseLine = line.toLowerCase();
            config.searchWords.forEach((word) => {
              if (lowerCaseLine.includes(word.toLowerCase())) {
                // Found the word: Add the buffer (current line + next 2 lines)
                const start = Math.max(lines.indexOf(line), 0);
                const context = lines.slice(start, start + 3).join("\n"); // Current + next 2 lines
                foundEntries.push(`Word: "${word}"\nContext:\n${context}`);
              }
            });
          }
        });

        stream.on("end", () => {
          if (foundEntries.length > 0) {
            resolve(`Log file "${file}" matches:\n${foundEntries.join("\n\n")}`);
          } else {
            resolve(null); // No matches found
          }
          lastReadTime[file] = stats.size; // Update last read position
          saveLastReadTime(); // Save updated read times to disk
        });

        stream.on("error", (error) => {
          reject(`Error reading log file "${file}": ${error.message}`);
        });
      });

      if (logIssues) {
        issues.push(logIssues);
      }
    } catch (error) {
      console.error("Error accessing log file:", file, error);
    }
  }

  return issues.length > 0 ? issues.join("\n") : null;
}

async function runChecks() {
  const issues = [];

  console.log(JSON.stringify(config));

  if (process.env.FREE_DISK_THRESHOLD) {
    const diskIssue = checkDiskSpace();
    if (diskIssue) issues.push(diskIssue);
  }

  if (process.env.FREE_RAM_THRESHOLD) {
    const ramIssue = checkRAM();
    if (ramIssue) issues.push(ramIssue);
  }

  if (process.env.CPU_UTIL_THRESHOLD) {
    const cpuIssue = checkCPU();
    if (cpuIssue) issues.push(cpuIssue);
  }

  if (process.env.PM2_APPS) {
    const pm2Issue = await checkPM2Apps();
    if (pm2Issue) issues.push(pm2Issue);
  }

  if (process.env.PROCESSES) {
    const processIssue = checkProcesses();
    if (processIssue) issues.push(processIssue);
  }

  if (process.env.LOG_FILES && process.env.SEARCH_WORDS) {
    const logIssue = await checkLogFiles();
    if (logIssue) issues.push(logIssue);
  }

  if (issues.length > 0) {
    await sendEmail("System Monitoring Alert", issues.join("\n"));
  } else {
    console.log("All checks passed.");
  }
}

runChecks().catch((error) => console.error("Error running checks:", error));
