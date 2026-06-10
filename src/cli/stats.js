import { savingsTracker } from "../proxy/savingsTracker.js"; // Adjust path if needed

try {
  // It automatically loads the state from the JSON file on initialization
  const summary = savingsTracker.getSummary();
  console.log(summary);
} catch (error) {
  console.error("❌ Error fetching stats:", error.message);
}