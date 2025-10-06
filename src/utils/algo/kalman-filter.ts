class KalmanFilter {
  private Q: number; // Process noise
  private R: number; // Measurement noise
  private P: number; // Estimation error covariance
  private x: number; // State estimate
  private K: number; // Kalman gain
  
  constructor(processNoise = 0.01, measurementNoise = 0.1) {
    this.Q = processNoise;
    this.R = measurementNoise;
    this.P = 1;
    this.x = 0;
    this.K = 0;
  }
  
  filter(measurement: number): number {
    // Prediction step
    this.P = this.P + this.Q;
    
    // Update step
    this.K = this.P / (this.P + this.R);
    this.x = this.x + this.K * (measurement - this.x);
    this.P = (1 - this.K) * this.P;
    
    return this.x;
  }
}