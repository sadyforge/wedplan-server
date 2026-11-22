
import express from "express";
import cors from "cors";
import "dotenv/config";
import Stripe from "stripe";
import { MongoClient, ObjectId } from "mongodb";
import { createHmac, timingSafeEqual } from "node:crypto";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000;
const jwtIssuer = process.env.BACKEND_JWT_ISSUER || "wedplan-client";
const jwtAudience = process.env.BACKEND_JWT_AUDIENCE || "wedplan-api";


// middleware
app.use(
  express.json({
    verify: (req, _res, buffer) => {
      if (req.path === "/payments/webhook" || req.originalUrl?.split("?")[0] === "/payments/webhook") {
        req.rawBody = Buffer.from(buffer);
      }
    },
  })
);
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


async function createPaymentIndexes() {
  await transactionsCollection.createIndex(
    { stripeInvoiceId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        stripeInvoiceId: { $type: "string" },
      },
    }
  );

  await transactionsCollection.createIndex(
    { stripeSessionId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        stripeSessionId: { $type: "string" },
      },
    }
  );

  await webhookEvents.createIndex(
    { eventId: 1 },
    { unique: true }
  );

  await transactionsCollection.createIndex({
    vendorId: 1,
    createdAt: -1,
  });

  await transactionsCollection.createIndex({
    vendorId: 1,
    stripeSubscriptionId: 1,
    paymentDate: -1,
  });
}


const databaseConnection = connectToMongoDB();
const database = client.db("wedplan");

// Better Auth (usePlural: false) stores accounts in singular collections:
// "user", "session", "account", "verification". Services live in "service".
// Transactions use the dedicated "transactions" collection (migrated from legacy "payments").
const services = database.collection("service");
const users = database.collection("user");
const bookingsCollection =database.collection("bookings");
const transactionsCollection = database.collection("transactions");
const webhookEvents = database.collection("stripe_webhook_events");

await databaseConnection;
await createPaymentIndexes();

// const myLogger=(req,res,next)=>{
//   console.log("now hitting the api",req.url, req.query)
//   next()
// }

const base64UrlDecode = (value) => Buffer.from(value, "base64url").toString("utf8");

const verifyToken = async (req, res, next) => {
  try {
    const secret = process.env.BACKEND_JWT_SECRET;
    const authorization = req.headers.authorization || "";
    const [scheme, token] = authorization.split(" ");

    if (!secret || scheme !== "Bearer" || !token) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const parts = token.split(".");
    if (parts.length !== 3) return res.status(401).json({ message: "Unauthorized" });

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (header.alg !== "HS256" || header.typ !== "JWT") {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const expectedSignature = createHmac("sha256", secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const receivedSignature = Buffer.from(encodedSignature, "base64url");
    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const now = Math.floor(Date.now() / 1000);
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (
      typeof payload.sub !== "string" ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= now ||
      (payload.nbf && payload.nbf > now) ||
      payload.iss !== jwtIssuer ||
      !audience.includes(jwtAudience)
    ) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!ObjectId.isValid(payload.sub)) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await users.findOne({ _id: new ObjectId(payload.sub) });
    if (!user || user.isBlocked === true || user.blocked === true) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    req.user = { ...user, id: user._id.toString() };
    next();
  } catch (error) {
    console.error("JWT verification failed:", error.message);
    return res.status(401).json({ message: "Unauthorized" });
  }
};







const verifyRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).send({
        success: false,
        message: "Forbidden: Access denied",
      });
    }

    next();
  };
};

const verifyVendor=async(req,res,next)=>{
  if(!req.user || req.user.role !== 'vendor'){
    res.status(403).send({message:"Forbidden"})
    return
  }
  next()
}


const isActiveSubscription = (status) =>
  status === "active" || status === "trialing";

function subscriptionFields(subscription) {
  const active = isActiveSubscription(subscription.status);

  return {
    subscriptionPlan: active ? "Premium" : "Free",
    subscriptionStatus: String(subscription.status || "incomplete"),
    premium: active,

    subscriptionId: String(subscription.id),

    stripeCustomerId:
      subscription.customer?.toString?.() ||
      subscription.customer ||
      null,

    subscriptionStartedAt: subscription.start_date
      ? new Date(subscription.start_date * 1000)
      : new Date(),

    subscriptionExpiresAt: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,

    subscriptionCancelledAt: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000)
      : null,

    subscriptionCancelAtPeriodEnd: Boolean(
      subscription.cancel_at_period_end
    ),
  };
}

async function updateVendorSubscription(userId, subscription) {
  if (!userId || !ObjectId.isValid(userId)) {
    throw new Error("Invalid vendor ID");
  }

  const result = await users.updateOne(
    {
      _id: new ObjectId(userId),
      role: "vendor",
    },
    {
      $set: subscriptionFields(subscription),
    }
  );

  console.log("MongoDB subscription update result:", {
    userId,
    subscriptionId: subscription.id,
    status: subscription.status,
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  });

  if (result.matchedCount !== 1) {
    throw new Error("Vendor not found");
  }

  return result;
}

async function recordTransaction(transaction) {
  const vendorId = String(transaction.vendorId || "");

  if (!ObjectId.isValid(vendorId)) {
    throw new Error("Invalid transaction vendor ID");
  }

  const vendor = await users.findOne(
    {
      _id: new ObjectId(vendorId),
      role: "vendor",
    },
    {
      projection: {
        name: 1,
        email: 1,
      },
    }
  );

  if (!vendor) {
    throw new Error("Transaction vendor not found");
  }

  const transactionData = {
    ...transaction,
    vendorId,
    vendorName: vendor.name || "Vendor",
    vendorEmail: vendor.email || "",
    paymentDate: transaction.paymentDate || transaction.createdAt || new Date(),
    createdAt: transaction.createdAt || new Date(),
  };

  if (transaction.stripeInvoiceId) {
    const result = await transactionsCollection.updateOne(
      {
        stripeInvoiceId: transaction.stripeInvoiceId,
      },
      {
        $setOnInsert: transactionData,
      },
      {
        upsert: true,
      }
    );

    console.log("TRANSACTION RESULT (by invoice):", {
      stripeInvoiceId: transaction.stripeInvoiceId,
      vendorId,
      upsertedCount: result.upsertedCount,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      isNew: result.upsertedCount > 0,
    });

    return result;
  }

  if (transaction.stripeSessionId) {
    const result = await transactionsCollection.updateOne(
      {
        stripeSessionId: transaction.stripeSessionId,
      },
      {
        $setOnInsert: transactionData,
      },
      {
        upsert: true,
      }
    );

    console.log("TRANSACTION RESULT (by session):", {
      stripeSessionId: transaction.stripeSessionId,
      vendorId,
      upsertedCount: result.upsertedCount,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      isNew: result.upsertedCount > 0,
    });

    return result;
  }

  throw new Error("Stripe transaction reference is required");
}

function getInvoiceSubscriptionId(invoice) {
  if (!invoice) return null;

  const parseSub = (sub) => {
    if (!sub) return null;
    if (typeof sub === "string" && sub.trim()) return sub.trim();
    if (typeof sub === "object" && typeof sub.id === "string" && sub.id.trim()) return sub.id.trim();
    return null;
  };

  return (
    parseSub(invoice.subscription) ||
    parseSub(invoice.parent?.subscription_details?.subscription) ||
    parseSub(invoice.subscription_details?.subscription) ||
    parseSub(invoice.lines?.data?.[0]?.subscription) ||
    parseSub(invoice.lines?.data?.[0]?.parent?.subscription_item_details?.subscription) ||
    parseSub(invoice.lines?.data?.[0]?.parent?.subscription_details?.subscription) ||
    null
  );
}


async function getAuthenticatedUser(req) {
  return req.user || null;
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

const publicRoute = (req) =>
  req.method === "GET" &&
  (req.path === "/" || req.path === "/browse-service" || req.path.startsWith("/browse-service/"));

app.use((req, res, next) => {
  if (req.method === "OPTIONS" || req.path === "/payments/webhook" || publicRoute(req)) return next();
  return verifyToken(req, res, next);
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

app.post("/services",verifyToken,
  verifyRole("vendor"), async (req, res) => {
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
      vendor?.premium === true &&
      isActiveSubscription(vendor?.subscriptionStatus);

    if (!isPremium) {
      const serviceCount = await services.countDocuments({
        vendorId: String(user.id),
        status: { $in: ["pending", "approved", "active", "published"] },
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
app.get("/services",verifyToken, async (req, res) => {
  // console.log('header on the server',req.headers)

  try {
    const user = await getAuthenticatedUser(req);

    const filter =
      user?.role === "admin"
        ? {}
        : user?.role === "vendor"
          ? {
              $or: [
                { vendorId: user.id },
                { vendorEmail: user.email },
              ],
            }
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
app.get("/my-services",   verifyToken,
  verifyRole("vendor"),async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user || user.role !== "vendor") {
      return res.status(403).send({
        success: false,
        message: "Vendor access required",
      });
    }

    const result = await services
      .find({
        $or: [{ vendorId: user.id }, { vendorEmail: user.email }],
      })
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
app.get("/vendor-services/:email",  verifyToken,
  verifyRole("vendor"), async (req, res) => {
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
      .find({
        $or: [{ vendorId: user.id }, { vendorEmail: user.email }],
      })
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
// app.get("/services/:id",verifyToken, async (req, res) => {
//   try {
//     const { id } = req.params;

//     if (!ObjectId.isValid(id)) {
//       return res.status(400).send({
//         success: false,
//         message: "Invalid service ID",
//       });
//     }

//     const user = await getAuthenticatedUser(req);

//     const filter =
//       user?.role === "admin"
//         ? { _id: new ObjectId(id) }
//         : user?.role === "vendor"
//           ? {
//               _id: new ObjectId(id),
//               $or: [
//                 { status: "approved" },
//                 { vendorEmail: user.email },
//               ],
//             }
//           : {
//               _id: new ObjectId(id),
//               status: "approved",
//             };

//     const result = await services.findOne(filter);

//     if (!result) {
//       return res.status(404).send({
//         success: false,
//         message: "Service not found",
//       });
//     }

//     res.send({
//       success: true,
//       data: result,
//     });
//   } catch (error) {
//     console.error("Get single service error:", error);

//     res.status(500).send({
//       success: false,
//       message: "Failed to fetch service",
//     });
//   }
// });
// app.get("/services/:id", verifyToken, async (req, res) => {
//   try {
//     const { id } = req.params;
//     const user = req.user;

//     if (!ObjectId.isValid(id)) {
//       return res.status(400).send({ message: "Invalid service ID" });
//     }

//     const service = await servicesCollection.findOne({
//       _id: new ObjectId(id),
//     });

//     if (!service) {
//       return res.status(404).send({ message: "Service not found" });
//     }

//     if (user.role === "admin") {
//       return res.send(service);
//     }

//     if (user.role === "vendor") {
//       if (
//         service.vendorEmail === user.email ||
//         service.status === "approved"
//       ) {
//         return res.send(service);
//       }

//       return res.status(403).send({ message: "Access denied" });
//     }

//     if (service.status === "approved") {
//       return res.send(service);
//     }

//     return res.status(403).send({ message: "Access denied" });
//   } catch (error) {
//     res.status(500).send({ message: "Failed to fetch service" });
//   }
// });


app.get("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    console.log("Service ID:", id);
    console.log("Authenticated user:", user?.email);

    if (!user) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid service ID" });
    }

    const service = await services.findOne({
      _id: new ObjectId(id),
    });

    console.log("Found service:", service);
    console.log("Service vendor:", service?.vendorEmail);
    console.log("Current vendor:", user.email);

    if (!service) {
      return res.status(404).send({ message: "Service not found" });
    }

    const isOwner =
      user.role === "vendor" &&
      (String(service.vendorId) === String(user.id) ||
        String(service.vendorEmail).toLowerCase() === String(user.email).toLowerCase());

    if (user.role === "admin" || isOwner || service.status === "approved") {
      return res.send(service);
    }

    return res.status(403).send({ message: "Access denied" });
  } catch (error) {
    console.error("Service details error:", error);
    return res.status(500).send({ message: "Failed to fetch service" });
  }
});


// update service
app.patch("/services/:id", verifyToken,
  verifyRole("vendor"), async (req, res) => {
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
      vendorId: user.id,
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
        vendorId: user.id,
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
app.delete("/services/:id",   verifyToken,
async (req, res) => {
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
      : {
          _id: new ObjectId(id),
          vendorId: user.id,
        };
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
app.patch("/services/:id/approve",  verifyToken,
  verifyRole("admin"), async (req, res) => {
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
app.patch("/services/:id/reject",  verifyToken,
  verifyRole("admin"), async (req, res) => {
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


// Attach vendor information to service documents so public cards and the
// service details page can display "Vendor Information" as required.
async function withVendorInfo(services) {
  const list = Array.isArray(services) ? services : [services];

  const vendorIds = [
    ...new Set(
      list
        .map((s) => String(s?.vendorId || ""))
        .filter((id) => ObjectId.isValid(id))
    ),
  ];
  const vendorEmails = [
    ...new Set(
      list.map((s) => String(s?.vendorEmail || "").toLowerCase()).filter(Boolean)
    ),
  ];

  const or = [];
  if (vendorIds.length) or.push({ _id: { $in: vendorIds.map((id) => new ObjectId(id)) } });
  if (vendorEmails.length)
    or.push({ email: { $in: vendorEmails } });

  const vendors = or.length
    ? await users
        .find({ $or: or }, { projection: { name: 1, email: 1, image: 1 } })
        .toArray()
    : [];

  const byId = new Map(vendors.map((v) => [String(v._id), v]));
  const byEmail = new Map(vendors.map((v) => [String(v.email || "").toLowerCase(), v]));

  const decorate = (service) => {
    if (!service) return service;
    const vendor =
      byId.get(String(service.vendorId || "")) ||
      byEmail.get(String(service.vendorEmail || "").toLowerCase());

    return {
      ...service,
      vendorName: service.vendorName || vendor?.name || "",
      vendorEmail: service.vendorEmail || vendor?.email || "",
      vendorImage: service.vendorImage || vendor?.image || "",
    };
  };

  return Array.isArray(services) ? list.map(decorate) : decorate(list);
}


// get only approved services for Browse Services
app.get("/browse-service", async (req, res) => {
  try {
    const result = await services
      .find({ status: "approved" })
      .sort({ approvedAt: -1 })
      .toArray();

    res.send(await withVendorInfo(result));
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

    res.send(await withVendorInfo(result));
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
        $or: [
          { vendorId: String(user.id) },
          { vendorEmail: String(user.email || "") },
          { vendorEmail: String(user.email || "").toLowerCase() },
        ],
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
        $or: [
          { vendorId: String(user.id) },
          { vendorEmail: String(user.email || "") },
          { vendorEmail: String(user.email || "").toLowerCase() },
        ],
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



//middleware payment
// const isActiveSubscription = (status) => {
//   return status === "active" || status === "trialing";
// };

// const subscriptionFields = (subscription) => {
//   return {
//     subscriptionPlan: isActiveSubscription(subscription.status)
//       ? "Premium"
//       : "Free",

//     subscriptionStatus: subscription.status,

//     subscriptionId: subscription.id,

//     stripeCustomerId: subscription.customer?.toString(),

//     subscriptionStartedAt: new Date(
//       subscription.start_date * 1000
//     ),

//     subscriptionExpiresAt: new Date(
//       subscription.current_period_end * 1000
//     ),

//     subscriptionCancelAtPeriodEnd:
//       subscription.cancel_at_period_end,

//     subscriptionCancelledAt: subscription.canceled_at
//       ? new Date(subscription.canceled_at * 1000)
//       : null,

//     premium: isActiveSubscription(subscription.status),
//   };
// };

//payments related apis

app.post("/payments/checkout-verify", verifyToken, verifyRole("vendor"), async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user || user.role !== "vendor") {
      return res.status(403).json({
        success: false,
        message: "Authenticated vendor access is required.",
      });
    }

    const { sessionId } = req.body;

    if (
      typeof sessionId !== "string" ||
      !sessionId.startsWith("cs_test_") &&
      !sessionId.startsWith("cs_live_")
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid checkout session ID.",
      });
    }

    const session = await stripe.checkout.sessions.retrieve(
      sessionId
    );

    if (session.metadata?.userId !== String(user.id)) {
      return res.status(403).json({
        success: false,
        message: "This checkout session does not belong to you.",
      });
    }

    if (session.mode !== "subscription") {
      return res.status(400).json({
        success: false,
        message: "Invalid subscription session.",
      });
    }

    if (
      session.status !== "complete" ||
      session.payment_status !== "paid"
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment has not been completed.",
      });
    }

    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id;

    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Subscription not found.",
      });
    }

    const subscription = await stripe.subscriptions.retrieve(
      subscriptionId
    );

    if (
      subscription.metadata?.userId !== String(user.id) ||
      !isActiveSubscription(subscription.status)
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Active subscription not found.",
      });
    }

    // IMPORTANT:
    // Do not activate Premium here.
    // Stripe Webhook is the only authority for activation.
const vendor = await users.findOne({
  _id: new ObjectId(user.id),
  role: "vendor",
});

if (!vendor) {
  return res.status(404).json({
    success: false,
    message: "Vendor not found.",
  });
}

if (
  vendor.subscriptionId &&
  vendor.subscriptionId !== subscription.id &&
  vendor.premium === true &&
  isActiveSubscription(vendor.subscriptionStatus)
) {
  return res.status(409).json({
    success: false,
    message: "Another active subscription already exists.",
  });
}

await updateVendorSubscription(String(user.id), subscription);

const verifyInvoiceId =
  (typeof session.invoice === "string" ? session.invoice : session.invoice?.id) ||
  (typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice?.id) ||
  null;

if (verifyInvoiceId || session.id) {
  try {
    await recordTransaction({
      vendorId: String(user.id),
      plan: "Premium",
      amount: (session.amount_total || 0) / 100,
      currency: session.currency || "bdt",
      paymentMethod: "card",
      paymentStatus: session.payment_status || "paid",
      stripeInvoiceId: verifyInvoiceId,
      stripeSubscriptionId: subscription.id,
      stripeSessionId: session.id,
      paymentDate: new Date(),
      createdAt: new Date(),
    });
  } catch (txError) {
    console.warn("Checkout verify recordTransaction notice:", txError.message);
  }
}

const updatedVendor = await users.findOne({
  _id: new ObjectId(user.id),
  role: "vendor",
});

const activated =
  updatedVendor?.subscriptionId === subscription.id &&
  updatedVendor?.premium === true &&
  updatedVendor?.subscriptionPlan === "Premium" &&
  isActiveSubscription(updatedVendor?.subscriptionStatus);

return res.status(200).json({
  success: true,
  verified: true,
  activated,
  subscriptionStatus: updatedVendor?.subscriptionStatus,
  subscriptionPlan: updatedVendor?.subscriptionPlan,
  message: activated
    ? "Premium subscription activated successfully."
    : "Subscription activation failed.",
});

  

  } catch (error) {
    console.error("Checkout Verification Error:", error);

    return res.status(500).json({
      success: false,
      message: "Payment verification failed.",
    });
  }
});


app.get("/users/:id/premium", verifyToken, async(req,res)=>{
  try {
    const id=req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid user ID" });
    if (req.user.role !== "admin" && String(req.user._id) !== id) {
      return res.status(403).json({ success: false, message: "You can only view your own premium status" });
    }
    const result=await users.findOne({ _id:new ObjectId(id) },{projection:{premium:1, subscriptionPlan:1, subscriptionStatus:1}});
    if (!result) return res.status(404).json({ success: false, message: "User not found" });
    res.send(result);
  } catch (error) {
    console.error("Get premium status error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch premium status" });
  }
})





// 1. Create Stripe Checkout Session

// app.post("/payments/create-checkout-session", async (req, res) => {
//   try {
//     const user = await getAuthenticatedUser(req);

//     if (!user || user.role !== "vendor") {
//       return res.status(403).json({
//         success: false,
//         message: "Only authenticated vendors can subscribe.",
//       });
//     }

//     const userId = String(user.id);

//     if (!ObjectId.isValid(userId)) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid vendor ID.",
//       });
//     }

//     const vendor = await users.findOne({
//       _id: new ObjectId(userId),
//       role: "vendor",
//     });

//     if (!vendor) {
//       return res.status(404).json({
//         success: false,
//         message: "Vendor not found.",
//       });
//     }

//     if (
//       vendor.subscriptionPlan === "Premium" &&
//       vendor.subscriptionStatus === "active"
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "You already have an active Premium subscription.",
//       });
//     }

//     const priceId = process.env.PREMIUM_PRICE_ID;

//     let lineItem;

//     if (priceId) {
//       lineItem = {
//         price: priceId,
//         quantity: 1,
//       };
//     } else {
//       const amount = Number(
//         process.env.PREMIUM_PRICE_AMOUNT || 99900
//       );

//       if (!Number.isInteger(amount) || amount <= 0) {
//         return res.status(400).json({
//           success: false,
//           message: "Invalid Premium subscription amount.",
//         });
//       }

//       lineItem = {
//         price_data: {
//           currency: (
//             process.env.PREMIUM_CURRENCY || "bdt"
//           ).toLowerCase(),

//           product_data: {
//             name: "WedPlan Premium",
//             description:
//               "Unlimited active services and Premium membership.",
//           },

//           unit_amount: amount,

//           recurring: {
//             interval: "month",
//           },
//         },

//         quantity: 1,
//       };
//     }

//     const session = await stripe.checkout.sessions.create({
//       mode: "subscription",

//       line_items: [lineItem],

//       customer_email: user.email,

//       client_reference_id: userId,

//       metadata: {
//         userId,
//       },

//       subscription_data: {
//         metadata: {
//           userId,
//         },
//       },

//       success_url:
//         `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,

//       cancel_url:
//         `${process.env.CLIENT_URL}/payment-cancel`,
//     });

//     return res.status(200).json({
//       success: true,
//       url: session.url,
//       sessionId: session.id,
//     });

//   } catch (error) {
//     console.error("Checkout Session Error:", error);

//     return res.status(500).json({
//       success: false,
//       message: "Failed to create checkout session.",
//     });
//   }
// });


app.post(
  "/payments/create-checkout-session",
  verifyToken,
  verifyRole("vendor"),
  async (req, res) => {
    try {
      const user = await getAuthenticatedUser(req);

      if (!user || user.role !== "vendor") {
        return res.status(403).json({
          success: false,
          message: "Only authenticated vendors can subscribe.",
        });
      }

      const userId = String(user.id || user._id || "");

      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid vendor ID.",
        });
      }

      const vendor = await users.findOne({
        _id: new ObjectId(userId),
        role: "vendor",
      });

      if (!vendor) {
        return res.status(404).json({
          success: false,
          message: "Vendor not found.",
        });
      }

      if (
        vendor.premium === true &&
        isActiveSubscription(vendor.subscriptionStatus)
      ) {
        return res.status(400).json({
          success: false,
          message: "You already have an active Premium subscription.",
        });
      }

      const priceId = process.env.PREMIUM_PRICE_ID;

      let lineItem;

      if (priceId) {
        lineItem = {
          price: priceId,
          quantity: 1,
        };
      } else {
        const amount = Number(
          process.env.PREMIUM_PRICE_AMOUNT || 99900
        );

        if (!Number.isInteger(amount) || amount <= 0) {
          return res.status(400).json({
            success: false,
            message: "Invalid Premium subscription amount.",
          });
        }

        lineItem = {
          price_data: {
            currency: (
              process.env.PREMIUM_CURRENCY || "bdt"
            ).toLowerCase(),

            product_data: {
              name: "WedPlan Premium",
              description:
                "Unlimited active services and Premium membership.",
            },

            unit_amount: amount,

            recurring: {
              interval: "month",
            },
          },

          quantity: 1,
        };
      }

      const checkoutOptions = {
        mode: "subscription",

        line_items: [lineItem],

        client_reference_id: userId,

        metadata: {
          userId,
        },

        subscription_data: {
          metadata: {
            userId,
          },
        },

        success_url:
          `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,

        cancel_url:
          `${process.env.CLIENT_URL}/payment-cancel`,
      };

      if (vendor.stripeCustomerId) {
        checkoutOptions.customer = String(
          vendor.stripeCustomerId
        );
      } else if (user.email || vendor.email) {
        checkoutOptions.customer_email =
          user.email || vendor.email;
      } else {
        return res.status(400).json({
          success: false,
          message: "Vendor email not found.",
        });
      }

      console.log("Creating Stripe Checkout Session:", {
        userId,
        vendorEmail: user.email || vendor.email,
      });

      const session =
        await stripe.checkout.sessions.create(checkoutOptions);

      console.log("Stripe Checkout Session created:", {
        userId,
        sessionId: session.id,
        metadataUserId: session.metadata?.userId,
      });
      return res.status(200).json({
        success: true,
        url: session.url,
        sessionId: session.id,
      });

    } catch (error) {
      console.error("Checkout Session Error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to create checkout session.",
      });
    }
  }
);


//webhook
app.post("/payments/webhook", async (req, res) => {
  const signature = req.headers["stripe-signature"];

  let event;

  // Verify Stripe webhook signature
  try {
    if (!req.rawBody) {
      console.error("Webhook raw body is missing.");

      return res.status(400).json({
        success: false,
        message: "Raw webhook body is missing.",
      });
    }

    event = stripe.webhooks.constructEvent(
      req.rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

  } catch (error) {
    console.error("Webhook Signature Error:", error.message);

    return res.status(400).json({
      success: false,
      message: "Invalid webhook signature.",
    });
  }

  try {
    // Check duplicate event
    const duplicate = await webhookEvents.findOne({
      eventId: event.id,
    });

    if (duplicate) {
      console.log("Duplicate Stripe Event:", event.id);

      return res.status(200).json({
        received: true,
        duplicate: true,
      });
    }

    console.log("Processing Stripe Event:", {
      eventType: event.type,
      eventId: event.id,
    });

    switch (event.type) {

      // 1. Checkout completed
      case "checkout.session.completed": {
        const session = event.data.object;
        const rawSubscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;

        console.log("Checkout completion payload:", {
          eventId: event.id,
          eventType: event.type,
          sessionId: session.id,
          paymentStatus: session.payment_status,
          subscriptionId: rawSubscriptionId || null,
          metadataUserId: session.metadata?.userId || null,
        });

        if (session.mode !== "subscription") {
          throw new Error(`Checkout session ${session.id} was not a subscription session.`);
        }

        const userId = session.metadata?.userId;

        if (!userId || !ObjectId.isValid(userId)) {
          throw new Error(
            "Invalid vendor ID in checkout metadata."
          );
        }

        if (!rawSubscriptionId) {
          throw new Error("Subscription ID not found.");
        }

        const subscription =
          await stripe.subscriptions.retrieve(rawSubscriptionId);

        console.log("Retrieved checkout subscription:", {
          eventId: event.id,
          sessionId: session.id,
          subscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          metadataUserId: subscription.metadata?.userId || null,
        });

        if (subscription.metadata?.userId !== userId) {
          throw new Error("Subscription vendor mismatch.");
        }

        if (!isActiveSubscription(subscription.status)) {
          throw new Error(`Subscription ${subscription.id} is not active (${subscription.status}); leaving event retryable.`);
        }

        const vendor = await users.findOne({
          _id: new ObjectId(userId),
          role: "vendor",
        });

        if (!vendor) {
          throw new Error(
            `Vendor not found. MongoDB ID: ${userId}`
          );
        }

        const updated = await updateVendorSubscription(
          userId,
          subscription
        );

        if (updated.matchedCount !== 1) {
          throw new Error(
            `Failed to update vendor subscription: ${userId}`
          );
        }

        const vendorAfterUpdate = await users.findOne(
          { _id: new ObjectId(userId), role: "vendor" },
          { projection: { _id: 1, premium: 1, subscriptionPlan: 1, subscriptionStatus: 1, subscriptionId: 1, stripeCustomerId: 1 } }
        );
        console.log("Vendor after checkout webhook update:", {
          eventId: event.id,
          vendorId: userId,
          matchedCount: updated.matchedCount,
          modifiedCount: updated.modifiedCount,
          vendor: vendorAfterUpdate,
        });

        if (vendorAfterUpdate?.premium !== true || vendorAfterUpdate?.subscriptionStatus !== "active" || vendorAfterUpdate?.subscriptionId !== subscription.id) {
          throw new Error(`Vendor subscription readback did not confirm activation for ${userId}.`);
        }

        const checkoutInvoiceId =
          (typeof session.invoice === "string" ? session.invoice : session.invoice?.id) ||
          (typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice?.id) ||
          null;

        await recordTransaction({
          vendorId: userId,
          plan: "Premium",
          amount: (session.amount_total || 0) / 100,
          currency: session.currency || "bdt",
          paymentMethod: "card",
          paymentStatus: session.payment_status || "paid",
          stripeInvoiceId: checkoutInvoiceId,
          stripeSubscriptionId: subscription.id,
          stripeSessionId: session.id,
          paymentDate: new Date(),
          createdAt: new Date(),
        });

        console.log("Checkout subscription updated and transaction recorded:", {
          userId,
          subscriptionId: subscription.id,
          invoiceId: checkoutInvoiceId,
          status: subscription.status,
        });

        break;
      }

      // 2. Subscription created or updated
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const eventSubscription = event.data.object;

        const subscription =
          await stripe.subscriptions.retrieve(
            eventSubscription.id
          );

        const userId = subscription.metadata?.userId;

        if (!userId || !ObjectId.isValid(userId)) {
          throw new Error(
            "Invalid vendor ID in subscription metadata."
          );
        }

        const vendor = await users.findOne({
          _id: new ObjectId(userId),
          role: "vendor",
        });

        console.log("Subscription event payload:", {
          eventId: event.id,
          eventType: event.type,
          subscriptionId: subscription.id,
          status: subscription.status,
          metadataUserId: userId,
          currentSubscriptionId: vendor?.subscriptionId || null,
        });

        if (!vendor) {
          throw new Error(
            `Subscription vendor not found: ${userId}`
          );
        }

        // Ignore events from an old subscription
        if (vendor.subscriptionId && vendor.subscriptionId !== subscription.id &&
            vendor.premium === true && isActiveSubscription(vendor.subscriptionStatus)) {
          console.log(
            "Ignoring old subscription event:",
            subscription.id
          );
          break;
        }

        const updated = await updateVendorSubscription(
          userId,
          subscription
        );

        if (!updated) {
          throw new Error(
            `Failed to update subscription: ${subscription.id}`
          );
        }

        console.log("Subscription updated:", {
          userId,
          subscriptionId: subscription.id,
          status: subscription.status,
          premium: isActiveSubscription(subscription.status),
        });

        break;
      }

      // 3. Subscription deleted
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;

        if (!userId || !ObjectId.isValid(userId)) {
          throw new Error(
            "Invalid vendor ID in deleted subscription."
          );
        }

        const result = await users.updateOne(
          {
            _id: new ObjectId(userId),
            role: "vendor",
            subscriptionId: subscription.id,
          },
          {
            $set: {
              subscriptionPlan: "Free",
              subscriptionStatus: "canceled",
              premium: false,

              subscriptionExpiresAt:
                subscription.current_period_end
                  ? new Date(
                      subscription.current_period_end * 1000
                    )
                  : null,

              subscriptionCancelledAt:
                subscription.canceled_at
                  ? new Date(
                      subscription.canceled_at * 1000
                    )
                  : new Date(),

              subscriptionCancelAtPeriodEnd: false,
            },
          }
        );

        if (result.matchedCount === 0) {
          console.log(
            "Deleted subscription did not match current vendor subscription:",
            subscription.id
          );
        }

        console.log("Subscription deleted:", {
          userId,
          subscriptionId: subscription.id,
          updated: result.modifiedCount > 0,
        });

        break;
      }

      // 4. Successful invoice payment
      case "invoice.payment_succeeded": {
        const invoice = event.data.object;

        const subscriptionId =
          getInvoiceSubscriptionId(invoice);

        if (!subscriptionId) {
          console.log(
            "No subscription ID found in invoice:",
            invoice.id
          );
          break;
        }

        const subscription =
          await stripe.subscriptions.retrieve(
            subscriptionId
          );

        let userId =
          subscription.metadata?.userId ||
          invoice.metadata?.userId ||
          invoice.parent?.subscription_details?.metadata?.userId ||
          invoice.subscription_details?.metadata?.userId ||
          invoice.lines?.data?.[0]?.metadata?.userId ||
          null;

        let vendor = null;
        if (userId && ObjectId.isValid(userId)) {
          vendor = await users.findOne({
            _id: new ObjectId(userId),
            role: "vendor",
          });
        }

        if (!vendor) {
          const customerId =
            (typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id) ||
            (typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id) ||
            null;

          if (customerId) {
            vendor = await users.findOne({
              stripeCustomerId: customerId,
              role: "vendor",
            });
          }

          if (!vendor && subscription.id) {
            vendor = await users.findOne({
              subscriptionId: subscription.id,
              role: "vendor",
            });
          }

          if (vendor) {
            userId = vendor._id.toString();
          }
        }

        if (!vendor || !userId || !ObjectId.isValid(userId)) {
          throw new Error(
            `Invoice vendor not found for invoice ${invoice.id} (subscription: ${subscriptionId})`
          );
        }

        const updated = await updateVendorSubscription(
          userId,
          subscription
        );

        if (!updated) {
          throw new Error(
            `Failed to activate vendor subscription: ${userId}`
          );
        }

        const paymentDate = invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : invoice.created
          ? new Date(invoice.created * 1000)
          : new Date();

        await recordTransaction({
          vendorId: userId,
          plan: "Premium",
          amount: (invoice.amount_paid || 0) / 100,
          currency: invoice.currency,
          paymentMethod: "card",
          paymentStatus: "paid",
          stripeInvoiceId: invoice.id,
          stripeSubscriptionId: subscription.id,
          stripePaymentIntentId:
            typeof invoice.payment_intent === "string"
              ? invoice.payment_intent
              : invoice.payment_intent?.id || null,
          paymentDate,
          createdAt: invoice.created
            ? new Date(invoice.created * 1000)
            : new Date(),
        });

        console.log("Invoice payment succeeded and transaction recorded:", {
          userId,
          invoiceId: invoice.id,
          subscriptionId: subscription.id,
          amount: (invoice.amount_paid || 0) / 100,
          currency: invoice.currency,
          paymentDate,
        });

        break;
      }

      // 5. Failed invoice payment
      case "invoice.payment_failed": {
        const invoice = event.data.object;

        const subscriptionId =
          getInvoiceSubscriptionId(invoice);

        if (!subscriptionId) {
          break;
        }

        const subscription =
          await stripe.subscriptions.retrieve(
            subscriptionId
          );

        const userId = subscription.metadata?.userId;

        if (!userId || !ObjectId.isValid(userId)) {
          throw new Error(
            "Invalid vendor ID in failed invoice metadata."
          );
        }

        const vendor = await users.findOne({
          _id: new ObjectId(userId),
          role: "vendor",
        });

        if (
          !vendor ||
          (
            vendor.subscriptionId &&
            vendor.subscriptionId !== subscription.id
          )
        ) {
          break;
        }

        const updated = await updateVendorSubscription(
          userId,
          subscription
        );

        if (!updated) {
          throw new Error(
            `Failed to update failed subscription: ${userId}`
          );
        }

        console.log("Invoice payment failed:", {
          userId,
          invoiceId: invoice.id,
          subscriptionStatus: subscription.status,
        });

        break;
      }

      default: {
        console.log(
          "Unhandled Stripe Event:",
          event.type
        );
      }
    }

    // Save event only after successful processing
    await webhookEvents.insertOne({
      eventId: event.id,
      type: event.type,
      processedAt: new Date(),
    });

    console.log("Stripe Event Processed:", {
      eventId: event.id,
      type: event.type,
    });

    return res.status(200).json({
      received: true,
    });

  } catch (error) {
    if (error.code === 11000) {
      return res.status(200).json({
        received: true,
        duplicate: true,
      });
    }

    console.error("Webhook Processing Error:", {
      eventId: event.id,
      eventType: event.type,
      message: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed.",
    });
  }
});

/* Legacy duplicate webhook implementation retained only as a reference.
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
            stripeCustomerId: subscription.customer?.toString?.() || subscription.customer,
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


*/

// 3. Get All Transactions (Admin Only)

app.get(["/payments/transactions", "/payments/my-transactions"], verifyToken, async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized access.",
      });
    }

    if (!["admin", "vendor"].includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    const filter =
      user.role === "admin"
        ? {}
        : {
            vendorId: String(user.id),
          };

    const transactions = await transactionsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      total: transactions.length,
      transactions,
    });

  } catch (error) {
    console.error("Get Transactions Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch transactions.",
    });
  }
});



app.get("/payments/my-subscription", verifyToken, verifyRole("vendor"), async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user || user.role !== "vendor") {
      return res.status(403).json({
        success: false,
        message: "Vendor access required.",
      });
    }

    const vendor = await users.findOne(
      {
        _id: new ObjectId(user.id),
        role: "vendor",
      },
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
          premium: 1,
        },
      }
    );

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: vendor,
    });

  } catch (error) {
    console.error("Get Subscription Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch subscription.",
    });
  }
});




app.post("/payments/cancel-subscription", verifyToken, verifyRole("vendor"), async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user || user.role !== "vendor") {
      return res.status(403).json({
        success: false,
        message: "Vendor access required.",
      });
    }

    const vendor = await users.findOne({
      _id: new ObjectId(user.id),
      role: "vendor",
    });

    if (
      !vendor?.subscriptionId ||
      !isActiveSubscription(vendor.subscriptionStatus)
    ) {
      return res.status(400).json({
        success: false,
        message: "No active Premium subscription found.",
      });
    }

    const currentSubscription = await stripe.subscriptions.retrieve(
      vendor.subscriptionId
    );

    if (!isActiveSubscription(currentSubscription.status)) {
      return res.status(400).json({
        success: false,
        message: "Subscription is not active.",
      });
    }

    if (currentSubscription.cancel_at_period_end) {
      return res.status(400).json({
        success: false,
        message: "Cancellation is already scheduled.",
      });
    }

    const subscription = await stripe.subscriptions.update(
      vendor.subscriptionId,
      {
        cancel_at_period_end: true,
      }
    );

    await updateVendorSubscription(user.id, subscription);

    return res.status(200).json({
      success: true,
      message:
        "Subscription cancellation scheduled successfully.",

      data: subscriptionFields(subscription),
    });

  } catch (error) {
    console.error("Cancel Subscription Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to cancel subscription.",
    });
  }
});



// JSON 404 for unknown API routes (avoids Express' default HTML 404 page).
app.use((req, res) => {
  res.status(404).send({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Global error handler — always respond with JSON, never leak a stack trace.
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  if (res.headersSent) return next(error);
  res.status(500).send({
    success: false,
    message: "Internal server error",
  });
});


app.listen(port, () => {
  console.log(`App is running on port ${port}`);
});


export default app;