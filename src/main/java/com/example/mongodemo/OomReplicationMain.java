package com.example.mongodemo;

import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import org.bson.Document;
import org.bson.conversions.Bson;

import java.util.ArrayList;
import java.util.List;

import static com.mongodb.client.model.Aggregates.limit;
import static com.mongodb.client.model.Aggregates.match;
import static com.mongodb.client.model.Filters.eq;

/**
 * Standalone JVM OOM replicator — no Spring Boot web server required.
 *
 * <p>Runs the same anti-pattern as {@link InvoiceController#bad(int)}:
 * server-side pipeline is cheap ({@code $match} + {@code $limit}), but
 * {@code aggregate(...).into(list)} materializes every document on the JVM heap.
 *
 * <p>Run with a small heap to force OOM quickly:
 * <pre>
 *   mvn -q -DskipTests package
 *   java -Xms128m -Xmx256m -cp target/mongo-jvm-demo-0.0.1-SNAPSHOT.jar \
 *     com.example.mongodemo.OomReplicationMain 500000
 * </pre>
 */
public final class OomReplicationMain {

    private static final String DEFAULT_URI = "mongodb://localhost:27017";
    private static final String DATABASE = "mongo_demo";
    private static final String COLLECTION = "invoices";

    private OomReplicationMain() {
    }

    public static void main(String[] args) {
        int limitCount = args.length > 0 ? Integer.parseInt(args[0]) : 500_000;
        String uri = System.getenv().getOrDefault("MONGODB_URI", DEFAULT_URI);

        System.out.printf(
                "OOM replication — materializing up to %,d READY invoices from %s/%s%n",
                limitCount,
                DATABASE,
                COLLECTION
        );
        System.out.printf("JVM heap max: %,d bytes%n%n", Runtime.getRuntime().maxMemory());

        List<Bson> pipeline = List.of(
                match(eq("status", "READY")),
                limit(limitCount)
        );

        long started = System.currentTimeMillis();
        try (MongoClient client = MongoClients.create(uri)) {
            MongoDatabase database = client.getDatabase(DATABASE);
            MongoCollection<Document> collection = database.getCollection(COLLECTION);

            long readyOnServer = collection.countDocuments(eq("status", "READY"));
            System.out.printf("Server: %,d documents match status=READY%n", readyOnServer);
            System.out.println("Client: calling aggregate(...).into(ArrayList) — full materialization...");
            System.out.flush();

            // Anti-pattern: loads the entire result set into the JVM heap at once.
            List<Document> materialized = collection.aggregate(pipeline).into(new ArrayList<>());

            long elapsedMs = System.currentTimeMillis() - started;
            System.out.printf(
                    "Completed without OOM — materialized %,d documents in %,d ms%n",
                    materialized.size(),
                    elapsedMs
            );
            System.out.println("(Increase limit or lower -Xmx to reproduce OutOfMemoryError)");
        } catch (OutOfMemoryError oom) {
            long elapsedMs = System.currentTimeMillis() - started;
            System.err.printf(
                    "%n*** OutOfMemoryError after %,d ms ***%n",
                    elapsedMs
            );
            System.err.println("Server pipeline was efficient; the JVM ran out of heap while materializing results.");
            System.err.println("Fix: stream the cursor (see InvoiceController /good or OomReplicationMain streaming mode).");
            throw oom;
        }
    }
}
