
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json());
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

// database connection
const client = new MongoClient(
  `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-36jm0na-shard-00-00.dcunazz.mongodb.net:27017,ac-36jm0na-shard-00-01.dcunazz.mongodb.net:27017,ac-36jm0na-shard-00-02.dcunazz.mongodb.net:27017/?ssl=true&replicaSet=atlas-lu33eg-shard-0&authSource=admin`
);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
}

const databaseConnection = connectToMongoDB();
const database = client.db("wedplan");

const payments = database.collection("payments");
const services = database.collection("service");
const users = database.collection("user");
const bookingsCollection =database.collection("bookings");

const authBaseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";

async function getAuthenticatedUser(req) {
  const cookie = req.headers.cookie;

  if (!cookie) return null;

  try {
    const response = await fetch(`${authBaseUrl}/api/auth/get-session`, {
      headers: { cookie },
    });
    const result = await response.json();
    return result?.user || result?.data?.user || null;
  } catch (error) {
    console.error("Session verification error:", error);
    return null;
  }
}

function validServiceData(data) {
  return (
    typeof data?.serviceName === "string" && data.serviceName.trim().length >= 3 &&
    typeof data?.category === "string" && data.category.trim() &&
    typeof data?.description === "string" && data.description.trim().length >= 20 &&
    Number.isFinite(Number(data?.price)) && Number(data.price) > 0 &&
    typeof data?.location === "string" && data.location.trim() &&
    typeof data?.image === "string" && data.image.trim()
  );
}

function serviceFields(data) {
  return {
    serviceName: data.serviceName.trim(),
    category: data.category.trim(),
    description: data.description.trim(),
    price: Number(data.price),
    location: data.location.trim(),
    image: data.image.trim(),
  };
}

// ensure database connection before handling requests
app.use(async (req, res, next) => {
  try {
    await databaseConnection;
    next();
  } catch (error) {
    console.error("Database connection failed:", error);
    res.status(500).send({
      success: false,
      message: "Database connection failed",
    });
  }
});

// home
app.get("/", (req, res) => {
  res.send("Hello world");
});

// ==============================
// USERS ROUTES
// ==============================

// get all users
app.get("/users", async (req, res) => {
  try {
    const result = await users.find({}).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch users",
    });
  }
});

// get single user
app.get("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid user ID",
      });
    }

    const result = await users.findOne({
      _id: new ObjectId(id),
    });

    if (!result) {
      return res.status(404).send({
        success: false,
        message: "User not found",
      });
    }

    res.send(result);
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch user",
    });
  }
});

// block user
app.patch("/users/:id/block", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid user ID",
      });
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isBlocked: true,
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        success: false,
        message: "User not found",
      });
    }

    res.send({
      success: true,
      message: "User blocked successfully",
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to block user",
    });
  }
});

// unblock user
app.patch("/users/:id/unblock", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid user ID",
      });
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isBlocked: false,
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        success: false,
        message: "User not found",
      });
    }

    res.send({
      success: true,
      message: "User unblocked successfully",
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to unblock user",
    });
  }
});





// add service
app.post("/services", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user || user.role !== "vendor") {
      return res.status(403).send({
        success: false,
        message: "Only vendors can add services",
      });
    }

    if (!validServiceData(req.body)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service data",
      });
    }

    const data = {
      ...serviceFields(req.body),
      vendorId: user.id,
      vendorEmail: user.email,
      vendorName: user.name || "",
      status: "pending",
      createdAt: new Date(),
    };

    const result = await services.insertOne(data);

    res.status(201).send({
      success: true,
      message: "Service submitted for approval",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Add service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to add service",
    });
  }
});


// get all services
app.get("/services", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    const filter =
      user?.role === "admin"
        ? {}
        : user?.role === "vendor"
          ? { vendorEmail: user.email }
          : { status: "approved" };

    const result = await services
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Get services error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch services",
    });
  }
});


// get my services
app.get("/my-services", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user || user.role !== "vendor") {
      return res.status(403).send({
        success: false,
        message: "Vendor access required",
      });
    }

    const result = await services
      .find({ vendorEmail: user.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Get my services error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch your services",
    });
  }
});


// get vendor services
app.get("/vendor-services/:email", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (
      !user ||
      user.role !== "vendor" ||
      user.email !== req.params.email
    ) {
      return res.status(403).send({
        success: false,
        message: "You can only access your own services",
      });
    }

    const result = await services
      .find({ vendorEmail: user.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Get vendor services error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch vendor services",
    });
  }
});


// get single service
app.get("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const user = await getAuthenticatedUser(req);

    const filter =
      user?.role === "admin"
        ? { _id: new ObjectId(id) }
        : user?.role === "vendor"
          ? {
              _id: new ObjectId(id),
              $or: [
                { status: "approved" },
                { vendorEmail: user.email },
              ],
            }
          : {
              _id: new ObjectId(id),
              status: "approved",
            };

    const result = await services.findOne(filter);

    if (!result) {
      return res.status(404).send({
        success: false,
        message: "Service not found",
      });
    }

    res.send({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Get single service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch service",
    });
  }
});


// update service
app.patch("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getAuthenticatedUser(req);

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    if (!user || user.role !== "vendor") {
      return res.status(403).send({
        success: false,
        message: "Only vendors can update services",
      });
    }

    const existingService = await services.findOne({
      _id: new ObjectId(id),
      vendorEmail: user.email,
    });

    if (!existingService) {
      return res.status(404).send({
        success: false,
        message: "Service not found or you are not the owner",
      });
    }

    const mergedData = {
      ...existingService,
      ...req.body,
    };

    if (!validServiceData(mergedData)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service data",
      });
    }

    const updateData = serviceFields(mergedData);

    if (Object.keys(updateData).length === 0) {
      return res.status(400).send({
        success: false,
        message: "No valid fields provided for update",
      });
    }

    const result = await services.updateOne(
      {
        _id: new ObjectId(id),
        vendorEmail: user.email,
      },
      {
        $set: {
          ...updateData,
          status: "pending",
          updatedAt: new Date(),
        },
        $unset: {
          approvedAt: "",
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        success: false,
        message: "Service not found or you are not the owner",
      });
    }

    res.send({
      success: true,
      message: "Service updated and submitted for approval",
    });
  } catch (error) {
    console.error("Update service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update service",
    });
  }
});


// delete service
app.delete("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getAuthenticatedUser(req);

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    if (!user || user.role !== "vendor") {
      return res.status(403).send({
        success: false,
        message: "Only vendors can delete services",
      });
    }

    const result = await services.deleteOne({
      _id: new ObjectId(id),
      vendorEmail: user.email,
    });

    if (!result.deletedCount) {
      return res.status(404).send({
        success: false,
        message: "Service not found or you are not the owner",
      });
    }

    res.send({
      success: true,
      message: "Service deleted successfully",
    });
  } catch (error) {
    console.error("Delete service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to delete service",
    });
  }
});


// approve service
app.patch("/services/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getAuthenticatedUser(req);

    if (!user || user.role !== "admin") {
      return res.status(403).send({
        success: false,
        message: "Only admin can approve services",
      });
    }

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const result = await services.updateOne(
      {
        _id: new ObjectId(id),
        status: "pending",
      },
      {
        $set: {
          status: "approved",
          approvedAt: new Date(),
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        success: false,
        message: "Pending service not found",
      });
    }

    res.send({
      success: true,
      message: "Service approved successfully",
    });
  } catch (error) {
    console.error("Approve service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to approve service",
    });
  }
});


// reject service
app.patch("/services/:id/reject", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getAuthenticatedUser(req);

    if (!user || user.role !== "admin") {
      return res.status(403).send({
        success: false,
        message: "Only admin can reject services",
      });
    }

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const result = await services.updateOne(
      {
        _id: new ObjectId(id),
        status: "pending",
      },
      {
        $set: {
          status: "rejected",
          rejectedAt: new Date(),
        },
        $unset: {
          approvedAt: "",
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        success: false,
        message: "Pending service not found",
      });
    }

    res.send({
      success: true,
      message: "Service rejected successfully",
    });
  } catch (error) {
    console.error("Reject service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to reject service",
    });
  }
});


// get only approved services for Browse Services
app.get("/browse-service", async (req, res) => {
  try {
    const result = await services
      .find({ status: "approved" })
      .sort({ approvedAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Browse services error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch browse services",
    });
  }
});


// get single approved service for public details
app.get("/browse-service/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const result = await services.findOne({
      _id: new ObjectId(id),
      status: "approved",
    });

    if (!result) {
      return res.status(404).send({
        success: false,
        message: "Service not found",
      });
    }

    res.send(result);
  } catch (error) {
    console.error("Browse single service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch service",
    });
  }
});



// customer book services
//post

// customer booking
app.post("/bookings", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).send({
        success: false,
        message: "Please login to book a service.",
      });
    }

    if (user.role !== "customer") {
      return res.status(403).send({
        success: false,
        message: "Only customers can book services.",
      });
    }

    const { serviceId, eventDate, eventLocation, message } = req.body;

    // validate required fields
    if (
      !serviceId ||
      !ObjectId.isValid(serviceId) ||
      !eventDate ||
      !eventLocation?.trim()
    ) {
      return res.status(400).send({
        success: false,
        message: "Please provide valid booking information.",
      });
    }

    // validate event date
   // validate event date
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Dhaka",
}).format(new Date());

const [year, month, day] = (eventDate || "").split("-").map(Number);

const validDate =
  datePattern.test(eventDate) &&
  year >= 1000 &&
  month >= 1 &&
  month <= 12 &&
  day >= 1 &&
  day <= new Date(Date.UTC(year, month, 0)).getUTCDate();

if (!validDate || eventDate < today) {
  return res.status(400).send({
    success: false,
    message: "Please select a valid future event date.",
  });
}

    // find approved service
    const service = await services.findOne({
      _id: new ObjectId(serviceId),
      status: "approved",
    });

    if (!service) {
      return res.status(404).send({
        success: false,
        message: "Approved service not found.",
      });
    }

    // vendor cannot book own service
    if (
      String(service.vendorId) === String(user.id) ||
      service.vendorEmail === user.email
    ) {
      return res.status(403).send({
        success: false,
        message: "You cannot book your own service.",
      });
    }

    // prevent duplicate active booking
    const existingBooking = await bookingsCollection.findOne({
      serviceId: serviceId,
      customerId: String(user.id),
      eventDate,
      status: { $in: ["Pending", "Accepted"] },
    });

    if (existingBooking) {
      return res.status(409).send({
        success: false,
        message: "You already have an active booking for this service and date.",
      });
    }

    // prepare booking data
    const bookingData = {
      serviceId: serviceId,
      serviceName: service.serviceName,
      serviceImage: service.image || service.images?.[0] || "",
      price: service.price,

      customerId: String(user.id),
      customerName: user.name || "",
      customerEmail: user.email,

      vendorId: String(service.vendorId || ""),
      vendorName: service.vendorName || "",
      vendorEmail: service.vendorEmail || "",

      eventDate,
      eventLocation: eventLocation.trim(),
      message: typeof message === "string" ? message.trim() : "",

      status: "Pending",
      createdAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(bookingData);

    res.status(201).send({
      success: true,
      message: "Booking request submitted successfully.",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Create booking error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to submit booking request.",
    });
  }
});


// get customer bookings
app.get("/my-bookings", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).send({
        success: false,
        message: "Please login to view your bookings.",
      });
    }

    if (user.role !== "customer") {
      return res.status(403).send({
        success: false,
        message: "Only customers can view their bookings.",
      });
    }

    const result = await bookingsCollection
      .find({
        customerId: String(user.id),
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Get customer bookings error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch bookings.",
    });
  }
});


// cancel customer booking
app.patch("/bookings/:id/cancel", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).send({
        success: false,
        message: "Please login to cancel your booking.",
      });
    }

    if (user.role !== "customer") {
      return res.status(403).send({
        success: false,
        message: "Only customers can cancel bookings.",
      });
    }

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid booking ID.",
      });
    }

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(id),
      customerId: String(user.id),
    });

    if (!booking) {
      return res.status(404).send({
        success: false,
        message: "Booking not found.",
      });
    }

    if (booking.status !== "Pending") {
      return res.status(400).send({
        success: false,
        message: "Only pending bookings can be cancelled.",
      });
    }

    const result = await bookingsCollection.updateOne(
      {
        _id: new ObjectId(id),
        customerId: String(user.id),
        status: "Pending",
      },
      {
        $set: {
          status: "Cancelled",
          cancelledAt: new Date(),
        },
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(409).send({
        success: false,
        message: "Booking could not be cancelled. Please try again.",
      });
    }

    res.send({
      success: true,
      message: "Booking cancelled successfully.",
    });
  } catch (error) {
    console.error("Cancel booking error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to cancel booking.",
    });
  }
});


// get vendor bookings
app.get("/vendor-bookings", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).send({
        success: false,
        message: "Please login to view bookings.",
      });
    }

    if (user.role !== "vendor") {
      return res.status(403).send({
        success: false,
        message: "Only vendors can view these bookings.",
      });
    }

    const result = await bookingsCollection
      .find({
        vendorId: String(user.id),
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Get vendor bookings error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch vendor bookings.",
    });
  }
});

// update booking status by vendor
app.patch("/bookings/:id/status", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).send({
        success: false,
        message: "Please login to update booking.",
      });
    }

    if (user.role !== "vendor") {
      return res.status(403).send({
        success: false,
        message: "Only vendors can update booking status.",
      });
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid booking ID.",
      });
    }

    if (!["Accepted", "Rejected"].includes(status)) {
      return res.status(400).send({
        success: false,
        message: "Invalid booking status.",
      });
    }

    const result = await bookingsCollection.updateOne(
      {
        _id: new ObjectId(id),
        vendorId: String(user.id),
        status: "Pending",
      },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Pending booking not found.",
      });
    }

    res.send({
      success: true,
      message: `Booking ${status.toLowerCase()} successfully.`,
    });
  } catch (error) {
    console.error("Update booking status error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update booking status.",
    });
  }
});

app.listen(port, () => {
  console.log(`App is running on port ${port}`);
});
