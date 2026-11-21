
import express from "express";
import cors from "cors";
import "dotenv/config";
import Stripe from "stripe";
import { MongoClient, ObjectId } from "mongodb";

const stripe=new Stripe(process.env.STRIPE_SECRET_KEY)
const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json({
  verify: (req, _res, buffer) => {
    if (req.originalUrl === "/payments/webhook") {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));
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
const transactionsCollection = database.collection("payments");
const webhookEvents = database.collection("stripe_webhook_events");

const authBaseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";

const isActiveSubscription = (status) =>
  status === "active" || status === "trialing";

function subscriptionFields(subscription) {
  const active = isActiveSubscription(subscription.status);
  return {
    subscriptionPlan: active ? "Premium" : "Free",
    subscriptionStatus: active ? "active" : "inactive",
    subscriptionId: String(subscription.id),
    stripeCustomerId: subscription.customer?.toString?.() || subscription.customer || null,
    subscriptionStartedAt: subscription.start_date
      ? new Date(subscription.start_date * 1000)
      : new Date(),
    subscriptionExpiresAt: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
    subscriptionCancelledAt: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000)
      : null,
    subscriptionCancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  };
}

async function updateVendorSubscription(userId, subscription) {
  if (!userId || !ObjectId.isValid(userId)) return false;
  const result = await users.updateOne(
    { _id: new ObjectId(userId) },
    { $set: subscriptionFields(subscription) }
  );
  return result.matchedCount > 0;
}

async function recordTransaction(transaction) {
  if (transaction.vendorId && ObjectId.isValid(String(transaction.vendorId))) {
    const vendor = await users.findOne(
      { _id: new ObjectId(String(transaction.vendorId)) },
      { projection: { name: 1, email: 1 } }
    );
    transaction = {
      ...transaction,
      vendorName: transaction.vendorName || vendor?.name || "Vendor",
      vendorEmail: transaction.vendorEmail || vendor?.email || "",
    };
  }
  const key = transaction.stripeInvoiceId || transaction.stripeSessionId;
  if (!key) return;
  await transactionsCollection.updateOne(
    transaction.stripeInvoiceId
      ? { stripeInvoiceId: transaction.stripeInvoiceId }
      : { stripeSessionId: transaction.stripeSessionId },
    { $setOnInsert: transaction },
    { upsert: true }
  );
}

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


// get all users
app.get("/users", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user || user.role !== "admin") {
      return res.status(403).send({ message: "Only admins can view users." });
    }
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
    const user = await getAuthenticatedUser(req);
    if (!user || user.role !== "admin") {
      return res.status(403).send({ message: "Only admins can view user details." });
    }
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
    const admin = await getAuthenticatedUser(req);
    if (!admin || admin.role !== "admin") {
      return res.status(403).send({ message: "Only admins can block users." });
    }
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
    const admin = await getAuthenticatedUser(req);
    if (!admin || admin.role !== "admin") {
      return res.status(403).send({ message: "Only admins can unblock users." });
    }
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

    const vendor = await users.findOne({
      _id: new ObjectId(user.id),
    });

    const isPremium =
      vendor?.subscriptionPlan === "Premium" &&
      vendor?.subscriptionStatus === "active";

    if (!isPremium) {
      const serviceCount = await services.countDocuments({
        vendorId: String(user.id),
        status: { $in: ["pending", "approved"] },
      });

      if (serviceCount >= 3) {
        return res.status(403).send({
          success: false,
          code: "SERVICE_LIMIT_REACHED",
          message:
            "You have reached your free service limit. Upgrade to Premium to add unlimited services.",
        });
      }
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

    if (!user || !["vendor", "admin"].includes(user.role)) {
      return res.status(403).send({
        success: false,
        message: "Only vendors or admins can delete services",
      });
    }

    const filter = user.role === "admin"
      ? { _id: new ObjectId(id) }
      : { _id: new ObjectId(id), vendorEmail: user.email };
    const result = await services.deleteOne(filter);

    if (!result.deletedCount) {
      return res.status(404).send({
        success: false,
        message: "Service not found or you are not allowed to delete it",
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


//payments related apis
app.post("/payments/checkout-verify", async (req, res) => {
  try {
    const { sessionId } = req.body;
    const authenticatedUser = await getAuthenticatedUser(req);

    if (!authenticatedUser || authenticatedUser.role !== "vendor") {
      return res.status(401).send({
        success: false,
        message: "Authenticated vendor access is required.",
      });
    }

    if (!sessionId) {
      return res.status(400).send({
        success: false,
        message: "Session ID is required",
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const {
      status,
      payment_status,
      payment_intent,
      metadata,
      customer_email,
    } = session;

    if (status !== "complete" || payment_status !== "paid") {
      return res.status(400).send({
        success: false,
        message: "Payment verification failed",
      });
    }

    if (!metadata?.userId || !ObjectId.isValid(metadata.userId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid user information",
      });
    }

    if (String(authenticatedUser.id) !== String(metadata.userId)) {
      return res.status(403).send({
        success: false,
        message: "This checkout session does not belong to the authenticated vendor.",
      });
    }

    const subscription = session.subscription
      ? await stripe.subscriptions.retrieve(session.subscription)
      : null;
    const vendor = await users.findOne({ _id: new ObjectId(metadata.userId) });

    if (!vendor || !subscription || !isActiveSubscription(subscription.status)) {
      return res.status(400).send({
        success: false,
        message: "Payment verification failed because the subscription is not active.",
      });
    }

    const subscriptionData = subscriptionFields(subscription);
    await users.updateOne(
      { _id: new ObjectId(metadata.userId) },
      { $set: { ...subscriptionData, premium: true } }
    );

    await recordTransaction({
      vendorId: metadata.userId,
      plan: "Premium",
      amount: (session.amount_total || 0) / 100,
      currency: session.currency,
      stripeSessionId: session.id,
      stripeSubscriptionId: subscription.id,
      status: "paid",
      createdAt: new Date(),
    });

    return res.send({
      success: true,
      verified: true,
      subscriptionStatus: "active",
      subscriptionPlan: "Premium",
      subscriptionId: subscription.id,
      message: "Premium subscription activated successfully.",
    });
  } catch (error) {
    console.error("Checkout verification error:", error);

    return res.status(500).send({
      success: false,
      message: "Payment verification failed",
    });
  }
});

app.get("/users/:id/premium",async(req,res)=>{
  const id=req.params.id
  const query={_id:new ObjectId(id)}
  const result=await users.findOne(query,{projection:{premium:1}})
  res.send(result)
})



// 1. Create Stripe Checkout Session
app.post("/payments/create-checkout-session", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({ message: "Unauthorized access." });
    }

    if (user.role !== "vendor") {
      return res.status(403).json({ message: "Only vendors can subscribe." });
    }

    const userId = user._id?.toString() || user.id;

    if (!userId) {
      return res.status(400).json({ message: "User ID not found." });
    }

    const existingUser = await users.findOne({
      _id: new ObjectId(userId),
    });

    if (!existingUser) {
      return res.status(404).json({ message: "Vendor not found." });
    }

    if (
      existingUser.subscriptionPlan === "Premium" &&
      existingUser.subscriptionStatus === "active"
    ) {
      return res.status(400).json({
        message: "You already have a Premium subscription.",
      });
    }

    const priceId = process.env.PREMIUM_PRICE_ID;
    const lineItem = priceId
      ? { price: priceId, quantity: 1 }
      : {
          price_data: {
            currency: (process.env.PREMIUM_CURRENCY || "bdt").toLowerCase(),
            product_data: {
              name: "WedPlan Premium",
              description: "Unlimited active services and Premium badge",
            },
            unit_amount: Number(process.env.PREMIUM_PRICE_AMOUNT || 99900),
            recurring: { interval: "month" },
          },
          quantity: 1,
        };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [lineItem],

      customer_email: user.email,

      metadata: {
        userId,
      },

      subscription_data: {
        metadata: {
          userId,
        },
      },

      success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment-cancel`,
    });

    res.status(200).json({
      success: true,
      url: session.url,
    });
  } catch (error) {
    console.error("Checkout Session Error:", error);

    res.status(500).json({
      message: "Failed to create checkout session.",
    });
  }
});


// 2. Stripe Webhook
// IMPORTANT: This route must be registered before express.json()

app.post(
  "/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody || req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Webhook Signature Error:", error.message);

      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      const duplicate = await webhookEvents.findOne({ eventId: event.id });
      if (duplicate) return res.status(200).json({ received: true, duplicate: true });

      switch (event.type) {
        // Payment successful
        case "checkout.session.completed": {
          const session = event.data.object;

          if (
            session.mode !== "subscription" ||
            session.payment_status !== "paid"
          ) {
            break;
          }

          const userId = session.metadata?.userId;

          if (!userId || !ObjectId.isValid(userId)) {
            break;
          }

          const subscription = await stripe.subscriptions.retrieve(
            session.subscription
          );

          await updateVendorSubscription(userId, subscription);
          await recordTransaction({
            vendorId: userId,
            plan: "Premium",
            amount: (session.amount_total || 0) / 100,
            currency: session.currency,
            stripeSessionId: session.id,
            stripeSubscriptionId: session.subscription,
            status: "paid",
            createdAt: new Date(),
          });

          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const subscription = event.data.object;
          const userId = subscription.metadata?.userId;

          if (!userId || !ObjectId.isValid(userId)) {
            break;
          }

          await updateVendorSubscription(userId, subscription);

          break;
        }

        // Subscription cancelled or expired
        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const userId = subscription.metadata?.userId;

          if (!userId || !ObjectId.isValid(userId)) {
            break;
          }

          await users.updateOne(
            { _id: new ObjectId(userId) },
            {
              $set: {
                subscriptionPlan: "Free",
                subscriptionStatus: "inactive",
                subscriptionExpiresAt: null,
                subscriptionCancelledAt: new Date(),
              },
            }
          );

          break;
        }

        case "invoice.payment_succeeded": {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription?.toString?.() || invoice.subscription;
          if (!subscriptionId) break;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const userId = subscription.metadata?.userId;
          if (!userId || !ObjectId.isValid(userId)) break;
          await updateVendorSubscription(userId, subscription);
          await recordTransaction({
            vendorId: userId,
            plan: "Premium",
            amount: (invoice.amount_paid || 0) / 100,
            currency: invoice.currency,
            stripeInvoiceId: invoice.id,
            stripeSubscriptionId: subscription.id,
            status: "paid",
            createdAt: new Date(),
          });
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription?.toString?.() || invoice.subscription;
          if (!subscriptionId) break;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const userId = subscription.metadata?.userId;
          if (!userId || !ObjectId.isValid(userId)) break;
          await updateVendorSubscription(userId, subscription);

          break;
        }

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      await webhookEvents.insertOne({ eventId: event.id, type: event.type, processedAt: new Date() });
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Webhook Processing Error:", error);

      res.status(500).json({
        message: "Webhook processing failed.",
      });
    }
  }
);


// 3. Get All Transactions (Admin Only)
app.get("/payments/transactions", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({ message: "Unauthorized access." });
    }

    if (user.role !== "admin" && user.role !== "vendor") {
      return res.status(403).json({
        message: "Only admins and vendors can view transactions.",
      });
    }

    const filter = user.role === "vendor"
      ? { vendorId: String(user.id) }
      : {};
    const transactions = await transactionsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    const transactionsWithVendor = await Promise.all(
      transactions.map(async (transaction) => {
        if (!transaction.vendorId || !ObjectId.isValid(String(transaction.vendorId))) {
          return transaction;
        }
        const vendor = await users.findOne(
          { _id: new ObjectId(String(transaction.vendorId)) },
          { projection: { name: 1, email: 1 } }
        );
        return {
          ...transaction,
          vendorName: transaction.vendorName || vendor?.name,
          vendorEmail: transaction.vendorEmail || vendor?.email,
        };
      })
    );

    res.status(200).json({
      success: true,
      total: transactionsWithVendor.length,
      transactions: transactionsWithVendor,
    });
  } catch (error) {
    console.error("Get Transactions Error:", error);

    res.status(500).json({
      message: "Failed to fetch transactions.",
    });
  }
});

app.get("/payments/my-subscription", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user || user.role !== "vendor") {
      return res.status(403).json({ message: "Vendor access required." });
    }

    const vendor = await users.findOne(
      { _id: new ObjectId(user.id) },
      {
        projection: {
          subscriptionPlan: 1,
          subscriptionStatus: 1,
          subscriptionId: 1,
          stripeCustomerId: 1,
          subscriptionStartedAt: 1,
          subscriptionExpiresAt: 1,
          subscriptionCancelledAt: 1,
          subscriptionCancelAtPeriodEnd: 1,
        },
      }
    );

    if (!vendor) return res.status(404).json({ message: "Vendor not found." });
    res.json({ success: true, data: vendor });
  } catch (error) {
    console.error("Get subscription error:", error);
    res.status(500).json({ message: "Failed to fetch subscription." });
  }
});

app.post("/payments/cancel-subscription", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user || user.role !== "vendor") {
      return res.status(403).json({ message: "Vendor access required." });
    }

    const vendor = await users.findOne({ _id: new ObjectId(user.id) });
    if (!vendor?.subscriptionId || vendor.subscriptionStatus !== "active") {
      return res.status(400).json({ message: "No active Premium subscription found." });
    }

    const subscription = await stripe.subscriptions.update(vendor.subscriptionId, {
      cancel_at_period_end: true,
    });
    await updateVendorSubscription(user.id, subscription);
    res.json({ success: true, data: subscriptionFields(subscription) });
  } catch (error) {
    console.error("Cancel subscription error:", error);
    res.status(500).json({ message: "Failed to schedule subscription cancellation." });
  }
});

app.listen(port, () => {
  console.log(`App is running on port ${port}`);
});
