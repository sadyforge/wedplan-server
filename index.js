
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json());
app.use(cors());

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
    const data = {
      ...req.body,
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
    const result = await services.find({}).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch services",
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

    const result = await services.findOne({
      _id: new ObjectId(id),
    });

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
    const data = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const updateData = {};

    if (data.serviceName !== undefined) updateData.serviceName = data.serviceName;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.price !== undefined) updateData.price = Number(data.price);
    if (data.location !== undefined) updateData.location = data.location;
    if (data.image !== undefined) updateData.image = data.image;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).send({
        success: false,
        message: "No valid fields provided for update",
      });
    }

    const result = await services.updateOne(
      { _id: new ObjectId(id) },
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
        message: "Service not found",
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

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const result = await services.deleteOne({
      _id: new ObjectId(id),
    });

    if (!result.deletedCount) {
      return res.status(404).send({
        success: false,
        message: "Service not found",
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

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const result = await services.updateOne(
      { _id: new ObjectId(id) },
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
        message: "Service not found",
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

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID",
      });
    }

    const result = await services.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: "rejected",
        },
        $unset: {
          approvedAt: "",
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        success: false,
        message: "Service not found",
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



// get only approved services
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

// get single approved service
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



app.listen(port, () => {
  console.log(`App is running on port ${port}`);
});
