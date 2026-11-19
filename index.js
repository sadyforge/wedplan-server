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
const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-36jm0na-shard-00-00.dcunazz.mongodb.net:27017,ac-36jm0na-shard-00-01.dcunazz.mongodb.net:27017,ac-36jm0na-shard-00-02.dcunazz.mongodb.net:27017/?ssl=true&replicaSet=atlas-lu33eg-shard-0&authSource=admin`);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
    throw err;
  }
}

const databaseConnection = connectToMongoDB();
const database = client.db("wedplan");


const payments = database.collection("payments");
const services=database.collection("service")
const browseService=database.collection("browse-service")

// ensure database connection before handling requests
app.use(async (req, res, next) => {
  try {
    await databaseConnection;
    next();
  } catch (error) {
    console.error("Database connection failed:", error);
    res.status(500).send({ message: "Database connection failed" });
  }
});

app.get("/", (req, res) => {
  res.send("Hello world");
});


// service post
app.post("/services", async (req, res) => {
  try {
    const data = req.body;

    const result = await services.insertOne(data);

    res.status(201).send({
      success: true,
      message: "Service added successfully",
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

//get services 
app.get("/services",async(req,res)=>{
    const result=await services.find({}).toArray()
    res.send(result)
})
// Get Single Service
app.get("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: new ObjectId(id) };

    const result = await services.findOne(query);

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

//update
app.patch("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;

    const updateData = {};

    if (data.serviceName !== undefined) updateData.serviceName = data.serviceName;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.price !== undefined) updateData.price = Number(data.price);
    if (data.location !== undefined) updateData.location = data.location;
    if (data.image !== undefined) updateData.image = data.image;

    const result = await services.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Service not found",
      });
    }

    res.send({
      success: true,
      message: "Service updated successfully",
    });
  } catch (error) {
    console.error("Update service error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update service",
    });
  }
});


//delete route
// Delete Service
app.delete("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID.",
      });
    }

    const query = { _id: new ObjectId(id) };

    const result = await services.deleteOne(query);

    if (result.deletedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Service not found.",
      });
    }

    res.send({
      success: true,
      message: "Service deleted successfully.",
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to delete service.",
    });
  }
});



//browse service
app.get("/browse-service",async(req,res)=>{
  const result=await browseService.find({}).toArray()
  res.send(result)
})

// Get single browse service
app.get("/browse-service/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const query = { _id: new ObjectId(id) };

    const result = await browseService.findOne(query);

    if (!result) {
      return res.status(404).send({
        message: "Service not found",
      });
    }

    res.send(result);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch service",
    });
  }
});


app.listen(port,()=>{
    console.log(`App is running on port ${port}`)
})


