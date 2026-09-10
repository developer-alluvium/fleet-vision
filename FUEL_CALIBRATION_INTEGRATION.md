# Fuel Calibration Frontend Implementation Specification

## 1. Executive Summary & Objective

This document outlines the product requirements, user experience (UX) flows, system interactions, and validation rules for integrating the **Fuel Sensor Calibration** module into the Client Dashboard (`fleet-dashboard`).

The goal is to allow fleet operators and installation technicians to easily pair Bluetooth Low Energy (BLE) fuel sensors to vehicles and calibrate the fuel tank volume without requiring technical tools or direct API calls.

---

## 2. Feature Placement & User Journey

### 2.1 Entry Points
* **Primary Entry Point:** Inside the **Vehicles Table / Grid** (`/vehicles`), add a **"Calibrate Fuel"** or **"Fuel Sensor"** option in the actions menu (`⋮`) for each vehicle row.
* **Secondary Entry Point (Optional):** Inside the **Vehicle Details / Edit Dialog**, include a dedicated **"Fuel & Sensors"** tab.

### 2.2 Modal Experience
Clicking the action opens a focused dialog/sheet titled: **"Fuel Calibration — [Vehicle Plate Number]"**.

The modal contains two primary functional sections:
1. **Sensor Channel Assignment** (Hardware Mapping)
2. **Calibration Curve Table** (Volume Mapping)

---

## 3. Functional Requirements

### 3.1 Sensor Channel Assignment (Hardware Mapping)
* **Purpose:** Instructs the data processor which BLE channel on the GPS tracker is receiving data from the fuel sensor.
* **UI Element:** Single-select dropdown.
* **Options Available:**
  * *Disabled / No Sensor* (Default if not configured)
  * *Channel 1 (IO Element 270)*
  * *Channel 2 (IO Element 273)*
  * *Channel 3 (IO Element 276)*
  * *Channel 4 (IO Element 279)*
* **Behavior:** Selecting "Disabled" clears the fuel channel binding for this vehicle.

### 3.2 Calibration Curve Table (Volume Mapping)
* **Purpose:** Maps the sensor's raw measurement ticks/frequency to actual physical volume in liters.
* **UI Element:** An interactive table with columns:
  * **Index:** Step number (1, 2, 3, etc.).
  * **Raw Sensor Reading:** Numeric input for raw sensor value.
  * **Fuel Volume (Liters):** Numeric input for corresponding volume.
  * **Actions:** Delete button per row.
* **Controls:**
  * **"+ Add Point" Button:** Appends a new row to the table.
  * **"Clear Table" Button:** Allows wiping all existing points with a confirmation prompt.
  * **"Save Calibration" Button:** Submits both the channel setting and the calibration table.

---

## 4. Business & Validation Rules

Before allowing the user to save, the frontend must validate the following conditions:

| Rule | Requirement | User Error Message |
| :--- | :--- | :--- |
| **Minimum Points** | Must contain at least **2 points** (e.g., Empty and Full). | *"At least 2 calibration points are required to build a curve."* |
| **Non-negative Values** | Both `Raw Value` and `Liters` must be $\ge 0$. | *"Values cannot be negative."* |
| **Unique Raw Values** | No two rows may have the same `Raw Value`. | *"Duplicate raw sensor reading detected."* |
| **Monotonically Increasing**| As the raw sensor value increases, the volume in liters must also increase or remain equal. | *"Liters must increase as raw values increase."* |
| **Capacity Ceiling** | No point's volume can exceed the vehicle's `Max Fuel Capacity`. | *"Volume cannot exceed vehicle capacity ([X] L)."* |

---

## 5. System & API Interaction Lifecycle

### Step 1: Dialog Initialization (Loading State)
When the modal opens for vehicle `vehicleId`:
* The frontend makes concurrent `GET` requests to:
  1. `/api/v1/vehicles/{vehicleId}/fuel-calibration` (fetches active channel)
  2. `/api/v1/vehicles/{vehicleId}/fuel-calibration-table` (fetches existing points)
* A loading skeleton or spinner displays while data is being retrieved.
* If no calibration points exist, the table defaults to two empty rows:
  * Row 1: `Raw Value: 0`, `Liters: 0`
  * Row 2: `Raw Value: 4095`, `Liters: [Vehicle Max Capacity]`

### Step 2: User Edits & Real-Time Feedback
* The user enters raw values and corresponding liters gathered during the tank filling process.
* The frontend automatically flags any monotonicity violations or missing fields in real-time.

### Step 3: Saving Configuration (Submission State)
When the user clicks **"Save Calibration"**:
1. The frontend sorts the points array in ascending order by `Raw Value`.
2. The frontend triggers two atomic updates:
   * `PUT /api/v1/vehicles/{vehicleId}/fuel-calibration` with the selected channel.
   * `PUT /api/v1/vehicles/{vehicleId}/fuel-calibration-table` with the sorted points array.
3. On HTTP 200:
   * Show a success notification: *"Fuel calibration saved and updated in cache."*
   * Close the modal and refresh the vehicle list/status.
4. On Error:
   * Keep the dialog open and display the exact error banner returned by the server.

---

## 6. UI States & Edge Case Handling

1. **Unsaved Changes Warning:**
   * If the user modifies values and attempts to close the dialog (via backdrop or close button), prompt for confirmation: *"You have unsaved calibration changes. Are you sure you want to exit?"*

2. **Deleting Existing Calibration:**
   * If a vehicle's sensor is removed, the user can choose to delete calibration data.
   * Sending a `DELETE` request to `/api/v1/vehicles/{vehicleId}/fuel-calibration-table` wipes the table and invalidates the Redis telemetry cache.

3. **Vehicles Without Max Capacity:**
   * If `maxFuelCapacity` is not set on the vehicle record, the system should allow arbitrary liter values or prompt the user to define vehicle tank capacity first.

4. **Telemetry Cache Synchronization:**
   * Inform the user via subtle helper text: *"Changes take effect immediately across all live telemetry processing without requiring a tracker reboot."*

---

## 7. Implementation Checklist for the Dashboard Team

- [ ] **Navigation & Triggers:** Add "Calibrate Fuel" action item to the Vehicles table row menu.
- [ ] **API Service Layer:** Wire up endpoints for channel retrieval, channel update, table retrieval, table update, and table deletion.
- [ ] **Modal Component:** Create the dialog container with responsive layout for desktop and tablet screens.
- [ ] **Channel Selector:** Implement the 4-channel dropdown mapped to the standard Teltonika/BLE IO IDs.
- [ ] **Dynamic Table:** Implement the point addition, deletion, and inline editing controls.
- [ ] **Validation Layer:** Enforce 2-point minimum, ascending order, non-negative inputs, and max capacity limits.
- [ ] **Feedback & Notifications:** Integrate toast notifications for success and inline banners for API/validation errors.
