import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";



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






// const verifyToken = async (req, res, next) => {
//   const authHeader = req.headers.authorization;
//   if (!authHeader) {
//     res.status(401).send({ message: "unauthorized" });
//     return;
//   }
//   const token = authHeader.split(" ")[1];
//   if (!token) {
//     res.status(401).send({ message: "unauthorized" });
//     return;
//   }
//   const query = { token };
//   const session = await sessions.findOne(query);
//   if (!session) {
//     res.status(401).send({ message: "unauthorized" });
//     return;
//   }
//   const userId = session.userId;
//   const userQuery = { _id: new ObjectId(userId) };
//   const user = await users.findOne(userQuery);
//   if (!user) {
//     res.status(401).send({ message: "unauthorized" });
//     return;
//   }
//   req.user = user;
//   next();
// };

// // must call this middleware after verifyTOken
// const verifySeeker = async (req, res, next) => {
//   if (req.user.role !== "seeker") {
//     res.status(401).send({ message: "unauthorized" });
//     return;
//   }
//   next();
// };

// const verifyRecruiter = async (req, res, next) => {
//   if (req.user.role !== "recruiter") {
//     res.status(401).send({ message: "unauthorized" });
//     return;
//   }
//   next();
// };

// const verifyAdmin = async (req, res, next) => {
//   if (req.user.role !== "admin") {
//     res.status(401).send({ message: "unauthorized" });
//     return;
//   }
//   next();
// };



// // payment related apis
// app.post("/payments/checkout-verify", async (req, res) => {
//   try {
//     const { sessionId } = req.body;

//     if (!sessionId) {
//       return res.send({
//         success: false,
//         message: "Session ID is required",
//       });
//     }

//     const {
//       status,
//       payment_status,
//       customer_email,
//       metadata,
//       payment_intent,
//     } = await stripe.checkout.sessions.retrieve(sessionId);

//     if (status === "complete" && payment_status === "paid") {
//       const sessionQuery = { sessionId };
//       const existingPayment = await payments.findOne(sessionQuery);

//       if (existingPayment) {
//         return res.send({
//           success: false,
//           message: "Payment already verified",
//         });
//       }

//       const payment = {
//         sessionId,
//         status,
//         payment_status,
//         customer_email,
//         userId: metadata.userId,
//         payment_date: new Date(),
//         payment_intent,
//       };

//       const result = await payments.insertOne(payment);

//       // update user table
//       const query = { _id: new ObjectId(metadata.userId) };

//       const updatedDoc = {
//         $set: {
//           premium: true,
//         },
//       };

//       const updateResult = await users.updateOne(query, updatedDoc);

//       res.send({ success: true, result, updateResult });
//       return;
//     }

//     res.send({
//       success: false,
//       message: "Payment verification failed",
//     });
//   } catch (error) {
//     console.error(error);

//     res.status(500).send({
//       success: false,
//       message: "Payment verification error",
//     });
//   }
// });


app.listen(port,()=>{
    console.log(`App is running on port ${port}`)
})


